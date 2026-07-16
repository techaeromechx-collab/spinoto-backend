/**
 * circuitBreaker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic circuit breaker for protecting the app from a slow/failing external
 * dependency (ImageKit, Web Push, or any future third-party call). Without
 * this, a hanging or erroring dependency can pile up in-flight requests —
 * each holding a request handler, a socket, and buffered memory — until the
 * whole app is starved, even though the dependency has nothing to do with
 * most of the app's actual work (e.g. the Postgres-backed pages).
 *
 * States:
 *   CLOSED     — normal operation. Calls go through. Failures are counted;
 *                once `failureThreshold` failures happen inside
 *                `failureWindowMs`, the breaker trips to OPEN.
 *   OPEN       — every call fails FAST (or runs the fallback) without ever
 *                touching the dependency, for `resetTimeoutMs`. This is the
 *                part that stops a hanging dependency from starving the app:
 *                once tripped, callers get an answer in ~0ms instead of
 *                waiting on a timeout every single time.
 *   HALF_OPEN  — after the cooldown, a limited number of trial calls
 *                (`halfOpenTrialCalls`) are allowed through to test whether
 *                the dependency has recovered. Any failure among them trips
 *                back to OPEN immediately; enough successes closes the
 *                breaker and resets it to normal operation.
 *
 * Every call — in any state — is also individually subject to:
 *   - a hard timeout (`requestTimeoutMs`), so a single hanging call can never
 *     block a request indefinitely, and
 *   - a concurrency cap (`maxConcurrent`), so even while CLOSED, a burst of
 *     slow calls can't spawn unbounded parallel work against the dependency.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreakerOpenError extends Error {
  constructor(name) {
    super(`Circuit breaker "${name}" is OPEN — failing fast without calling the dependency.`);
    this.name = 'CircuitBreakerOpenError';
    this.status = 503;
  }
}

class CircuitBreakerTimeoutError extends Error {
  constructor(name, ms) {
    super(`Circuit breaker "${name}": call exceeded ${ms}ms timeout.`);
    this.name = 'CircuitBreakerTimeoutError';
    this.status = 504;
  }
}

class CircuitBreakerBusyError extends Error {
  constructor(name, max) {
    super(`Circuit breaker "${name}": concurrency limit (${max}) reached — failing fast rather than queueing.`);
    this.name = 'CircuitBreakerBusyError';
    this.status = 503;
  }
}

class CircuitBreaker {
  /**
   * @param {string} name
   * @param {object} opts
   * @param {number} [opts.failureThreshold=5]   consecutive/windowed failures before tripping OPEN
   * @param {number} [opts.failureWindowMs=30000] window in which failures are counted toward the threshold
   * @param {number} [opts.resetTimeoutMs=15000]  how long to stay OPEN before trying HALF_OPEN
   * @param {number} [opts.requestTimeoutMs=8000] per-call timeout — a call slower than this counts as a failure
   * @param {number} [opts.maxConcurrent=5]       max in-flight calls to the dependency at once
   * @param {number} [opts.halfOpenTrialCalls=1]  trial calls allowed through per HALF_OPEN window
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.failureWindowMs = opts.failureWindowMs ?? 30_000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 15_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 8_000;
    this.maxConcurrent = opts.maxConcurrent ?? 5;
    this.halfOpenTrialCalls = opts.halfOpenTrialCalls ?? 1;

    this.state = STATE.CLOSED;
    this.failureTimestamps = [];
    this.openedAt = null;
    this.inFlight = 0;
    this.halfOpenInFlight = 0;
  }

  getState() {
    // OPEN → HALF_OPEN transition is lazy: checked on the next call, not on a timer.
    if (this.state === STATE.OPEN && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = STATE.HALF_OPEN;
      this.halfOpenInFlight = 0;
    }
    return this.state;
  }

  _recordFailure() {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter(t => now - t <= this.failureWindowMs);

    if (this.state === STATE.HALF_OPEN) {
      this._trip();
    } else if (this.state === STATE.CLOSED && this.failureTimestamps.length >= this.failureThreshold) {
      this._trip();
    }
  }

  _recordSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.CLOSED;
    }
    this.failureTimestamps = [];
  }

  _trip() {
    this.state = STATE.OPEN;
    this.openedAt = Date.now();
    this.failureTimestamps = [];
  }

  /**
   * Run `fn` through the breaker. `fn` should be a zero-arg function
   * returning a Promise (the actual call to the external dependency).
   *
   * Throws CircuitBreakerOpenError / CircuitBreakerBusyError immediately
   * (fail fast, no dependency call made) or CircuitBreakerTimeoutError if
   * the call itself didn't finish in time.
   */
  async fire(fn) {
    const state = this.getState();

    if (state === STATE.OPEN) {
      throw new CircuitBreakerOpenError(this.name);
    }

    if (state === STATE.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.halfOpenTrialCalls) {
        throw new CircuitBreakerOpenError(this.name);
      }
      this.halfOpenInFlight++;
    }

    if (this.inFlight >= this.maxConcurrent) {
      if (state === STATE.HALF_OPEN) this.halfOpenInFlight--;
      throw new CircuitBreakerBusyError(this.name, this.maxConcurrent);
    }

    this.inFlight++;
    try {
      const result = await this._withTimeout(fn());
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure();
      throw err;
    } finally {
      this.inFlight--;
      if (state === STATE.HALF_OPEN) this.halfOpenInFlight--;
    }
  }

  _withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CircuitBreakerTimeoutError(this.name, this.requestTimeoutMs)), this.requestTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

module.exports = { CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerTimeoutError, CircuitBreakerBusyError, STATE };
