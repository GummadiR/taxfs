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

**STATUS: ALL PORTED (2026-08-28), each with e2e coverage in
`apps/web/e2e/parity.spec.ts`.** Original gap table kept for the record.

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

**STATUS: BOTH PORTED (2026-08-28)** — `amend` (1040-X cases over the
filed baseline, IL companion) and `risk` (audit readiness + Defense File
download), with Mark-as-Filed added to File It.

| Screen | TaxOS UI | Needs | What it does |
|---|---|---|---|
| `amend` | 188 | `packages/postfiling` | Post-filing corrections; 1040-X columns; the filed record never changes |
| `risk` | 117 | `packages/defense` | Audit readiness (not odds prediction); the defense file |

## 4. Packages absent entirely

**STATUS: ALL THREE PORTED (2026-08-28)** with their full test suites (98
tests) — plus a durability improvement TaxOS lacked: capture records,
estimated payments, transcript lines, built 1040-X columns and the FILED
baseline persist as settings rows instead of vanishing with the server
session.

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

## 6a. Front-end port audit (2026-08-30) — screens REBUILT, not ported

Section 7 below claimed the port was complete. For the server and the
packages it was; for the **screens** it was not, and saying so was wrong.
Five screens had been written fresh against the TaxFS data model rather than
ported, and each lost substance the original carried. The operator found it
before this ledger did.

The audit compared every screen's rendered surface against its TaxOS
original. Findings, and their state:

| Screen | What was lost by rebuilding | State |
|---|---|---|
| Review | Lineage: a `?lineage=` query param and a flat list, in place of the drawer — no in-place drill-down, no plain-English origin words, no adds-up ledger line, no grouping of repeated leaves, concept ids and formula refs shown instead of hidden behind "For your CPA" | Ported verbatim |
| Documents | The confirmation panel showed no evidence: the confirm buttons had migrated to Review, with no document, no box, no confidence, and no type-to-verify on a low-confidence reading | Rebuilt on the fact model with the same substance |
| Sidebar | Per-step status badges and hover hints; active-section marking; click feedback. Fifteen numbered links, none of which said which one was waiting on you | Ported (`nav-link.tsx`, `nav-status.ts`) |
| Audit Readiness | Acknowledgment reduced to a bare button writing a list of critic ids to settings — while the §7602 disclosure above it says a ledger showing documented reasoning defends and one showing bare clicks convicts. The ported `RiskLedger`, which enforces exactly that, sat unused | Screen wired through the ledger; typed phrase and rationale restored |
| Get Started | Said only that identity never reaches the server, never where it IS entered — the operator went looking and could not find it | Pointer to the File It identity panel |

Deliberate differences, NOT regressions:

- TaxOS kept filing identity in an encrypted local file; TaxFS keeps it in
  the browser behind a passphrase and types it onto the PDF at download
  time (G9). Stronger, and proven by the journey e2e.
- TaxOS `Clients` → TaxFS `Workspaces` (§5).

### Still open

- **File It has no unlock path.** TaxOS required an explicit unlock with a
  recorded reason before a locked package could be superseded (D.5).
  `PackageStore.unlock(package_id, reason)` is ported in `@taxfs/forms` and
  enforces it, but the screen never calls it: `buildLockedPackage` inserts
  a new version unconditionally, so a locked version can be superseded with
  no reason recorded anywhere. Also missing with it: the version history
  table and the impact preview.

### The lesson

A ported screen and a rebuilt screen typecheck identically and pass the same
gates — the gates test behaviour, and a screen that lost a guardrail still
behaves. What catches it is comparing the rendered surface against the
original, screen by screen. "Ported" now means that comparison was done.

## 7. Port status — COMPLETE (server and packages; see §6a for screens)

Everything in §2, §3 and §4 is ported and green on the full gate chain
(2026-08-28): 925 unit tests, 41 Playwright specs against the production
build. Fifteen screens; real upload runs the P15 scrubber locally with
all honesty rules preserved.

Remaining recorded gaps (carried, not new):
- Review-page delta recording onto an open amendment case (columns compute
  from corrected facts regardless).
- Entity→personal K-1 orchestrator handoff (enter your own K-1 on Add
  Data from the generated numbers — same as TaxOS).
- The §6 gaps in both projects (section 6 above).
