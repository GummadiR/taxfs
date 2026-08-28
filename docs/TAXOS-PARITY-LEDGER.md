# TaxOS → TaxFS parity ledger

Authoritative list of what TaxOS has that TaxFS does not, measured by
comparing the two codebases directly (2026-08-28). Written because the
operator's standing ask was **TaxOS whole, optimized** — and the Blueprint's
§7 build order was narrower than that without ever saying so. Discovering
gaps one spot-check at a time is the operator doing the job twice; this file
exists so that never happens again.

Update this file in the same PR as any port. An item is DONE only when its
tests pass in the gate chain.

## 1. At parity — carried over, verified by measurement

| | TaxFS | TaxOS |
|---|---|---|
| Tax concepts | 172 | 172 |
| Golden returns | 42 | 43 |
| Critics | 26 | 26 |
| kernel / kernel2 / spine / shared / agents / forms | at or above parity | — |
| Carryovers: 5 types roll year-to-year, immutable closings, Gate-3 continuity | identical files | identical |

TaxFS additionally has, and TaxOS does not: forced RLS on every table,
workspace-scoped composite keys, client-side identity (no SSN reaches the
server), lint inside the gate chain, and a §9.1 negative test per guardrail.

## 2. Screens absent — engine ALREADY in TaxFS (UI port only)

These need wiring, not invention. Named engine verified present.

| Screen | TaxOS UI | Engine in TaxFS | What it does |
|---|---|---|---|
| `data` | 442 | kernel K-1 handling | Structured entry for multi-value items (K-1s, foreign amounts, exchange rates) |
| `year-round` | 312 | `spine/yearclose` + registers | Estimated tax, deduction capture, carryforwards, the year-close roll |
| `entities` | 250 | `kernel/entity.ts` | Businesses that file their own returns (1120-S, 1065) |
| `business` | 150 | `kernel/entity.ts` | The separate business returns themselves |
| `efile` | 130 | computed return values | E-file companion: the exact values to type into the IRS site |
| `forms` | 100 | `packages/forms` | Draft return rendered as form lines (1040, schedules, IL-1040) |
| `interview` | 78 | `agents/discovery` | Gap interview — asks only what the documents could not answer |
| `documents` upload | 425 + 133 dropzone | `agents/extraction` (464 lines, tested) | Real file upload → scrub → extraction. TaxFS has demo docs + typed entry only (94 lines) |

Subtotal: ~1,930 lines of UI against engines that already pass their tests.

## 3. Screens absent — package must be ported first

| Screen | TaxOS UI | Needs | What it does |
|---|---|---|---|
| `amend` | 188 | `packages/postfiling` | Post-filing corrections; 1040-X columns; the filed record never changes |
| `risk` | 117 | `packages/defense` | Audit readiness (not odds prediction); the defense file |

## 4. Packages absent entirely

| Package | Lines | Modules |
|---|---|---|
| `defense` | 1,136 | risk, capture, esttax (2210 Sch AI), benchmarks, defense-file, txfranchise, fbar |
| `postfiling` | 716 | cases (freeze on Mark Filed), amendment, notice, rules |
| `compliance` | 702 | benchmark (line-by-line vs an independently prepared return), canary + fixtures, checksum, retention, release, unified-log |

## 5. Equivalents — present under a different name

- TaxOS `clients` → TaxFS `workspaces` (plus membership roles and RLS, which
  TaxOS lacked).

## 6. Recorded gaps, identical in BOTH projects

Not regressions; carried forward as-is.

- NOL is a register kind but does not roll
- Basis endings (7203 line 15 / outside basis) are not kernel-emitted; only
  suspended losses roll
- Per-asset MACRS state rolls when multi-year depreciation lands
- §1.1 matrix gaps: Social Security worksheet, 8889/8606 official templates,
  per-spouse W-2 attribution, Sch B payer detail, 1116 per-country rows,
  6251/AMT

## 7. Port order (recommended)

Section 2 first — highest value per unit of work, because the engines are
already proven. Within it: `documents` upload, then `forms`, then
`year-round`, then `data`, then `interview`, then `efile`, then
`entities`/`business`. Section 4 packages next, each with its screen.
