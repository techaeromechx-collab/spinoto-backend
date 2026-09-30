'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Nobody holds a pooled client while asking the pool for another one.

   test_pool.js proves the hang on one real endpoint. This one is the guard that
   covers the other hundred and thirteen files, forever, and it does not care
   about line numbers going stale — it re-reads the tree every run.

   The rule, in one sentence: between `pool.connect()` and the matching
   `client.release()`, nothing may await anything that needs a SECOND connection.
   That means no `pool.query`, and no awaited call to a function that reaches for
   the shared pool itself.

   Two legitimate shapes pass:
     • the transaction ends, the client is released, and the rest runs after it;
     • the client is released EARLY inside the try, with a `released` flag so the
       catch does not roll back a connection it no longer owns and the finally
       does not release it twice.
   The second shape is what advances.service.js refundAdvance has always used.
   ───────────────────────────────────────────────────────────────────────────*/
const fs = require('fs');
const path = require('path');

/* Defaults to this repo's own backend/src — run it with `node backend/test/pool/
   pool-discipline.test.js` from anywhere. SPINOTO_SRC overrides it, which is how
   it was proved to FAIL against a copy with the bug put back. */
const ROOT = process.env.SPINOTO_SRC || path.resolve(__dirname, '../../src');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const check = (c, m) => c ? ok(m) : bad(m);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['templates', 'fonts', 'node_modules'].includes(e.name)) walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const src = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(from), spec);
  for (const c of [p, `${p}.js`, path.join(p, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/* Every function that ends up touching the shared pool, directly or through
   another function in its own file. Awaiting one of these while holding a client
   is the same bug as a bare pool.query — which is why grepping for pool.query
   alone once made this look like a five-site problem. */
const poolFns = new Set();
const bodies = new Map();
const owner = new Map();
for (const f of files) {
  const lines = src.get(f).split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?function\s+(\w+)|^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) marks.push([i, m[1] || m[2]]);
  }
  for (let k = 0; k < marks.length; k++) {
    const [ln, name] = marks[k];
    const end = k + 1 < marks.length ? marks[k + 1][0] : lines.length;
    const key = `${f}::${name}`;
    bodies.set(key, lines.slice(ln, end).join('\n'));
    owner.set(key, f);
    if (/\bpool\.(query|connect)\(/.test(bodies.get(key))) poolFns.add(key);
  }
}
for (let round = 0; round < 4; round++) {
  for (const [key, body] of bodies) {
    if (poolFns.has(key)) continue;
    for (const k2 of poolFns) {
      if (owner.get(k2) !== owner.get(key)) continue;
      if (new RegExp(`\\bawait\\s+${k2.split('::')[1]}\\s*\\(`).test(body)) { poolFns.add(key); break; }
    }
  }
}

const violations = [];   // pool used while the client is definitely still held
const early = [];        // functions that release early — checked for the flag

for (const f of files) {
  const lines = src.get(f).split('\n');
  const rel = path.relative(ROOT, f);

  const imports = new Map();
  for (const ln of lines) {
    const m = ln.match(/^(?:const|let)\s+(\{[^}]*\}|\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (!m) continue;
    const t = resolveImport(f, m[2]);
    if (!t) continue;
    if (m[1].startsWith('{')) {
      for (const n of m[1].replace(/[{}]/g, '').split(',')) {
        const nm = n.split(':')[0].trim();
        if (nm) imports.set(nm, t);
      }
    } else imports.set(m[1], t);
  }
  const localPoolFns = [...poolFns].filter(k => owner.get(k) === f).map(k => k.split('::')[1]);

  const connects = [];
  for (let i = 0; i < lines.length; i++) if (/pool\.connect\(\)/.test(lines[i])) connects.push(i);

  for (let ci = 0; ci < connects.length; ci++) {
    const start = connects[ci];
    const hardEnd = ci + 1 < connects.length ? connects[ci + 1] : lines.length;
    let end = -1;
    for (let j = start + 1; j < hardEnd; j++) if (/\.release\(\)/.test(lines[j])) end = j;
    if (end < 0) { violations.push({ rel, fn: '?', at: start + 1, what: 'pool.connect() with no release()' }); continue; }

    let fn = '?';
    for (let k = start; k >= 0; k--) {
      const m = lines[k].match(/^(?:async )?function (\w+)|^(?:const|let) (\w+) *= *(?:async )?[\(f]/);
      if (m) { fn = m[1] || m[2]; break; }
    }
    const region = lines.slice(start, end + 1).join('\n');

    for (let j = start + 1; j < end; j++) {
      const ln = lines[j];
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) continue;

      const uses = [];
      if (/\bpool\.query\(/.test(ln)) uses.push('pool.query');
      for (const nm of localPoolFns) {
        if (nm === fn) continue;
        if (new RegExp(`\\bawait\\s+${nm}\\s*\\(`).test(ln)) uses.push(`await ${nm}()`);
      }
      for (const [nm, mod] of imports) {
        if (!/\bpool\.(query|connect)\(/.test(src.get(mod) || '')) continue;
        if (!new RegExp(`\\bawait\\s+${nm}\\s*\\(`).test(ln)) continue;
        const a = ln.match(new RegExp(`\\b${nm}\\s*\\(\\s*([\\w.]*)`));
        if (a && /^(client|db|tx|conn|pool)$/.test(a[1])) continue;   // handed a connection
        uses.push(`await ${nm}()`);
      }
      if (!uses.length) continue;

      let releasedBefore = false;
      for (let k = start + 1; k < j; k++) {
        if (/^\s*(\/\/|\*)/.test(lines[k])) continue;
        if (/\.release\(\)/.test(lines[k])) releasedBefore = true;
      }
      /* The flag is declared BEFORE pool.connect(), so the bookkeeping check
         below has to look at the whole enclosing function, not just the
         connect-to-release window. */
      const whole = bodies.get(`${f}::${fn}`) || region;
      if (releasedBefore) early.push({ rel, fn, at: j + 1, region: whole });
      else violations.push({ rel, fn, at: j + 1, what: uses.join(' + ') });
    }
  }
}

console.log('\n── nobody holds a client while asking for another ─────────────');
console.log(`${files.length} files under ${ROOT}\n`);

if (violations.length) {
  for (const v of violations) console.log(`   ${v.rel} :: ${v.fn}  line ${v.at}  ${v.what}`);
  console.log('');
}
check(violations.length === 0,
      `no handler awaits a second connection while holding one (${violations.length} found)`);

/* An early release is fine — and is the only way some of these handlers can be
   written — but it has to be bookkept, or the finally releases a client that has
   already gone back to the pool and the catch rolls back a transaction it no
   longer owns. Both throw, and both throw from the error path, where nobody is
   watching. */
const seen = new Set();
let flagged = 0, unflagged = [];
for (const e of early) {
  const key = `${e.rel}::${e.fn}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const hasFlag    = /\b(let|var)\s+released\s*=\s*false/.test(e.region);
  const guardsFin  = /if\s*\(!released\)\s*(\{\s*)?client\.release\(\)/.test(e.region)
                  || /if\s*\(!released\)\s*\{[^}]*client\.release\(\)/s.test(e.region);
  const guardsRoll = !/client\.query\(['"]ROLLBACK/.test(e.region)
                  || /if\s*\(!released\)/.test(e.region);
  if (hasFlag && guardsFin && guardsRoll) flagged++;
  else unflagged.push(`${e.rel} :: ${e.fn} (flag:${hasFlag} finally:${guardsFin} rollback:${guardsRoll})`);
}
if (unflagged.length) { console.log(''); for (const u of unflagged) console.log(`   ${u}`); console.log(''); }
check(unflagged.length === 0,
      `every early release is bookkept with a released flag (${flagged} of ${flagged + unflagged.length})`);

/* The seatbelt. Even with every site above correct, a pool with no acquire
   timeout turns the next un-audited mistake into a dead server instead of a
   handful of 500s. */
const dbCfg = fs.readFileSync(path.join(ROOT, 'config/db.js'), 'utf8');
check(/connectionTimeoutMillis\s*:/.test(dbCfg),
      'the pool has a connectionTimeoutMillis, so a starved acquire fails loudly');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
