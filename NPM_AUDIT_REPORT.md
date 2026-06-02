# npm Audit Security Report — Spinoto Backend

> Generated: 2026-05-21  
> Tool: `npm audit`  
> Directory: `Spinoto/backend`  
> Command: `npm audit`

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 2 |
| 🟠 High | 1 |
| 🟡 Moderate | 1 |
| **Total** | **4 vulnerabilities** |

---

## Vulnerability Details

---

### 1. 🟡 Moderate — `brace-expansion`

| Field | Detail |
|-------|--------|
| **Package** | `brace-expansion` |
| **Affected Versions** | `5.0.2 – 5.0.5` |
| **Severity** | Moderate |
| **Type** | Denial of Service (DoS) |
| **Location** | `node_modules/brace-expansion` |
| **Fix Available** | ✅ Yes — `npm audit fix` |
| **Advisory** | https://github.com/advisories/GHSA-jxxr-4gwj-5jf2 |

**Description:**  
A large numeric range in brace expansion defeats the documented `max` DoS protection, allowing an attacker to trigger excessive CPU usage by passing crafted input strings.

**Recommended Fix:**
```bash
npm audit fix
```

---

### 2. 🔴 Critical — `underscore`

| Field | Detail |
|-------|--------|
| **Package** | `underscore` |
| **Affected Versions** | `<= 1.13.7` (all versions) |
| **Severity** | Critical |
| **Type** | Arbitrary Code Execution + Denial of Service |
| **Location** | `node_modules/underscore` |
| **Fix Available** | ❌ No fix available |
| **Advisories** | https://github.com/advisories/GHSA-cf4h-3jhx-xvhq |
|  | https://github.com/advisories/GHSA-qpx9-hpmf-5gmw |

**Description:**  
Two critical issues in `underscore`:
1. **Arbitrary Code Execution** — Malicious input can trigger code execution via `_.flatten` or `_.isEqual`.
2. **Unlimited Recursion / DoS** — `_.flatten` and `_.isEqual` have unbounded recursion, making them exploitable for Denial of Service attacks.

**Recommended Fix:**  
No patch is available. Options:
- **Replace `underscore` with `lodash`** (actively maintained, API-compatible for most use cases).
- Audit which features of `underscore` are used and implement them natively or with a patched alternative.
- Identify and remove/replace the `export` package that depends on `underscore`.

---

### 3. 🔴 Critical (via dependency) — `export`

| Field | Detail |
|-------|--------|
| **Package** | `export` |
| **Affected Versions** | All (`*`) |
| **Severity** | Critical (inherited) |
| **Type** | Depends on vulnerable `underscore` |
| **Location** | `node_modules/export` |
| **Fix Available** | ❌ No fix available |

**Description:**  
The `export` package depends on vulnerable versions of `underscore`. All vulnerabilities from `underscore` apply transitively to `export`.

**Recommended Fix:**  
- Remove the `export` package if not actively used.
- Find an alternative package that does not depend on `underscore`.

---

### 4. 🟠 High — `xlsx`

| Field | Detail |
|-------|--------|
| **Package** | `xlsx` (SheetJS) |
| **Affected Versions** | All (`*`) |
| **Severity** | High |
| **Type** | Prototype Pollution + ReDoS |
| **Location** | `node_modules/xlsx` |
| **Fix Available** | ❌ No fix available |
| **Advisories** | https://github.com/advisories/GHSA-4r6h-8v6p-xvw6 |
|  | https://github.com/advisories/GHSA-5pgg-2g8v-p4x9 |

**Description:**  
Two high-severity issues in SheetJS (`xlsx`):
1. **Prototype Pollution** — Maliciously crafted spreadsheet files can pollute the JavaScript prototype chain, potentially leading to remote code execution.
2. **Regular Expression Denial of Service (ReDoS)** — Crafted input can trigger catastrophic backtracking in regex patterns, causing the server to hang.

**Recommended Fix:**  
No patch available in the free `xlsx` package. Options:
- **Migrate to `exceljs`** — actively maintained, no known critical vulnerabilities.
- **Migrate to `xlsx-js-style`** — a maintained fork with some patches.
- If using SheetJS Pro (paid), consider upgrading to the commercial version which receives security patches.
- Strictly validate and sanitize all spreadsheet files before processing.

---

## Quick Fix Commands

```bash
# Fix issues that have automated patches (brace-expansion only):
npm audit fix

# View all details including transitive dependencies:
npm audit --json

# Check which top-level packages pull in vulnerable dependencies:
npm ls underscore
npm ls xlsx
npm ls export
```

---

## Dependency Chain

```
export  *
└── underscore  <=1.13.7  [CRITICAL]

xlsx  *  [HIGH]
└── (self — no safe version exists in npm registry)

brace-expansion  5.0.2 - 5.0.5  [MODERATE]
└── (auto-fixable via npm audit fix)
```

---

## Priority Action Plan

| Priority | Action | Effort |
|----------|--------|--------|
| 🔴 1 | **Replace `xlsx`** with `exceljs` | Medium |
| 🔴 2 | **Replace `underscore` / remove `export`** or switch to `lodash` | Medium |
| 🟡 3 | Run `npm audit fix` to patch `brace-expansion` | Low |
| 🟢 4 | Re-run `npm audit` to confirm all issues resolved | Low |

---

## Recommended Replacements

| Vulnerable Package | Recommended Replacement | Notes |
|--------------------|------------------------|-------|
| `xlsx` | [`exceljs`](https://www.npmjs.com/package/exceljs) | Actively maintained, read/write Excel |
| `underscore` | [`lodash`](https://www.npmjs.com/package/lodash) | Drop-in compatible for most APIs |
| `export` | Remove or replace | Check if actually used in codebase |

---

## References

- npm audit docs: https://docs.npmjs.com/cli/v10/commands/npm-audit
- GHSA-jxxr-4gwj-5jf2 (brace-expansion): https://github.com/advisories/GHSA-jxxr-4gwj-5jf2
- GHSA-cf4h-3jhx-xvhq (underscore ACE): https://github.com/advisories/GHSA-cf4h-3jhx-xvhq
- GHSA-qpx9-hpmf-5gmw (underscore DoS): https://github.com/advisories/GHSA-qpx9-hpmf-5gmw
- GHSA-4r6h-8v6p-xvw6 (xlsx Prototype Pollution): https://github.com/advisories/GHSA-4r6h-8v6p-xvw6
- GHSA-5pgg-2g8v-p4x9 (xlsx ReDoS): https://github.com/advisories/GHSA-5pgg-2g8v-p4x9
