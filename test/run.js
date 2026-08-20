#!/usr/bin/env node
'use strict';

/**
 * The test runner.
 *
 * WHY THERE IS NO TEST FRAMEWORK HERE
 * ───────────────────────────────────
 * Every suite in this directory is a plain Node script that throws on failure.
 * No jest, no mocha, no config file, no transform step — `node test/foo.test.js`
 * runs one suite by itself, exactly as CI runs it, with nothing in between that
 * could behave differently. That property is worth more than the conveniences a
 * framework would add, because these suites exist to be trusted about money.
 *
 * This runner adds one thing on top: running all of them and reporting which
 * failed, rather than stopping at the first.
 *
 * WHAT A SUITE MUST DO
 * ────────────────────
 *   • exit 0 and print one summary line on success
 *   • exit non-zero on failure (a bare `assert` does this for free)
 *   • print `SKIPPED` in its summary if it cannot run — see the postgres suite,
 *     which needs a scratch database and declines rather than failing when
 *     there is not one
 *
 * ONE SUITE, ONE FILE, NO SHARED STATE. Suites run in separate processes, so a
 * module one of them stubs cannot leak into another.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const only = process.argv[2] || null;

const suites = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !only || f.includes(only))
  .sort();

if (!suites.length) {
  console.error(only ? `No suite matches "${only}".` : 'No suites found.');
  process.exit(1);
}

let passed = 0, failed = 0, skipped = 0, checks = 0;
const failures = [];

for (const file of suites) {
  let out = '', ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(DIR, file)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: DIR,
    });
  } catch (err) {
    ok = false;
    out = (err.stdout || '') + (err.stderr || '');
  }

  const last = out.trim().split('\n').filter(Boolean).pop() || '(no output)';

  if (!ok) {
    failed++;
    failures.push({ file, out });
    console.log(`  FAIL  ${file}`);
  } else if (/SKIPPED/.test(last)) {
    skipped++;
    console.log(`  skip  ${file} — ${last}`);
  } else {
    passed++;
    const m = last.match(/(\d+)\s+(?:checks|assertions|scenario checks)/);
    if (m) checks += Number(m[1]);
    console.log(`  ok    ${file} — ${last}`);
  }
}

if (failures.length) {
  console.log('\n' + '─'.repeat(60));
  for (const f of failures) {
    console.log(`\n${f.file}\n${'─'.repeat(f.file.length)}`);
    console.log(f.out.trim().split('\n').slice(0, 25).join('\n'));
  }
}

console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed · ${failed} failed · ${skipped} skipped · ${checks.toLocaleString()} checks`);
process.exit(failed ? 1 : 0);
