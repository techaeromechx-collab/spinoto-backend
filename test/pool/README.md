# The connection-pool guard

```bash
node backend/test/pool/pool-discipline.test.js
```

No database, no server, no dependencies. It reads every `.js` file under
`backend/src` and answers one question: **does anything hold a pooled client
while asking the pool for another one?**

Run it before any deploy. It takes under a second.

## Why it exists

`config/db.js` opens a pool of **10** connections. Until 24 Sep 2026 it had no
acquire timeout, which means a request waiting for a connection waited forever.

Twenty-one functions checked out a client, and then — while still holding it —
awaited something that needed a second one: a read-back on `pool.query`, or an
`await` on a helper that owns its own connection (`advanceAppointmentStatus`,
`loadUser`, `_getItems`, `notifyOwners`, `findExisting`, …).

Ten of those at the same moment took all ten connections, and every one of them
then waited for an eleventh that could not exist. Nothing timed out. No query
was slow. Postgres saw nothing wrong — this was never a database deadlock, it
was the pool eating itself. **The backend simply stopped answering until
somebody restarted it.**

## What the test checks

1. **No held-client second acquire.** Between `pool.connect()` and the matching
   `client.release()`, nothing may await anything needing another connection.
   Failures are printed as `file :: function  line N  what`.

2. **Early releases are bookkept.** Two shapes are legal — end the transaction
   and release, then do the rest; or release early inside the `try` with a
   `released` flag. The flag is not optional: without it the `finally` releases a
   client that has already gone back to the pool, and the `catch` rolls back a
   transaction it no longer owns. Both throw, and both throw on the error path
   where nobody is watching. `advances.service.js :: refundAdvance` is the
   original of this shape.

3. **The pool still has `connectionTimeoutMillis`.** The seatbelt. Every site
   above is fixed, but the twenty-second one will be written by somebody who has
   not read this file. With a ceiling on the wait, that mistake costs a few
   seconds of 500s in the log; without it, a dead server.

### It is not grep

`pool.query` alone finds five of the twenty-one. The test resolves each file's
`require`s, works out which functions reach the shared pool — including
transitively, through another function in the same file — and flags an `await` on
any of them. A call that is *handed* a connection (`fn(client, …)`) is fine and
is not flagged.

## The two tests that need a database

`pool-discipline.test.js` proves the rule holds everywhere. Two companions prove
the rule matters, and they need a scratch Postgres plus a proxy that puts a
realistic network round-trip in front of it — on a unix socket the requests
never overlap and the bug cannot show itself:

- **`test_pool.js`** — 9 / 15 / 40 concurrent `POST /api/invoices/:id/payments`
  against the real controller. Before the fix: 15 concurrent → 15 hung, pool
  `{total:10, idle:0, waiting:15}`. After: all 40 complete.
- **`test_seatbelt.js`** — the *old* broken handler on a pool that has the
  timeout. 15 × HTTP 500 within 10.4s, pool back to 10 idle, and the next
  request served in 254ms. A loud failure that clears, instead of a silent one
  that does not.

Both live outside the repo because they need that scratch rig. Ask and they can
be brought in with a `docker compose` for the database.
