# Gate proofs — each gate broken deliberately once (Phase 1 acceptance)

Blueprint §9.1 requires every guardrail to be proven by attempting the
forbidden thing. Beyond the standing negative tests (which run in CI
forever), each gate in the chain was broken once by hand in this session,
the red result recorded, and the break reverted. Full logs were captured at
proof time; excerpts below are verbatim.

| # | Gate | Deliberate break | Result |
|---|------|------------------|--------|
| 1 | `lint` | unused variable appended to `packages/shared/src/index.ts` | exit 1 — `✖ 1 problem (1 error)` |
| 2 | `lint` (money-lint) | `wages * rate + 0.01` in a real file under `packages/kernel/src/` | exit 1 — `✖ 2 problems` (both `no-restricted-syntax`) |
| 3 | `audit:values` | `export const STANDARD_DEDUCTION_MFJ = 30000;` in kernel scope | exit 1 — `numeric literal 30000 (>= 50) — tax figures belong in rule data (G4)` |
| 4 | `typecheck` | `const broken: number = "not a number"` in shared | exit 2 — `TS2322` |
| 5 | `build` (production) | `main { @apply not-a-real-utility; }` in `globals.css` — the P86 broken-stylesheet class | **see below** — required hardening; now exit 1 |
| 6 | `test` (unit) | golden expectation flipped in `workspace-wiring.test.ts` | exit 1 — `1 failed \| 3 passed` |
| 7 | `e2e` (vs production build) | `<h1>` demoted to `<h2>` (passes build, breaks the UI contract) | exit 1 — `toBeVisible failed`, `1 failed 1 passed` |

## The gate 5 finding (P86 recurred in a new form — and was caught)

`next build` (16.3.2, Tailwind v4) **printed**
`Error: Cannot apply unknown utility class 'not-a-real-utility'`
**but exited 0**, with or without build cache — the raw build gate silently
green-lights a broken stylesheet, exactly the failure class N7 exists to
stop. Two walls now bind:

1. **`scripts/build-strict.mjs`** wraps `next build` and fails the gate when
   the build output contains an `Error:` line even at exit 0. Re-proof:
   broken CSS → exit 1 naming the utility class; clean tree → exit 0.
2. **The e2e styles-applied assertion** (`pages-render.spec.ts`) proved
   itself before the hardening existed: against the broken-CSS production
   build, the plain "renders with 200" spec PASSED (the page serves,
   unstyled) while `styles actually applied` FAILED. A route-200 check alone
   would not have caught P86; the computed-style assertion did.

## Standing negative tests (run in CI on every push)

- G3 money-lint: seeded float/`toNumber()`/string-concat defects flagged
  in-scope, silent out-of-scope, real source clean —
  `packages/kernel/test/money-lint.test.ts` (6 tests).
- G4 hardcoded values: seeded dollar literal flagged; small structural
  constants, comment prose, and reasoned `audit-allow` lines pass —
  `scripts/audit-hardcoded.test.ts` (5 tests).
- P86-class server reuse: `reuseExistingServer` must stay gated on
  `PW_REUSE=1` — `apps/web/test/e2e-config-guard.test.ts`.

## Phase 2 break proofs (tenancy guards)

| # | Guard | Deliberate break | Result |
|---|-------|------------------|--------|
| 8 | FORCE-RLS catalog guard | `alter table settings no force row level security` appended to the migration | suite red — `every public table has RLS enabled AND forced` fails |
| 9 | no-identity-columns guard (G9, schema level) | `alter table settings add column ssn_last4 text` | suite red — `no identity columns exist anywhere` fails |

Both reverted; suite 14/14 green after revert. The G1/G2 suite itself is
negative by construction (every test attempts the forbidden read/write and
passes only on refusal) and runs in CI against a real postgres:16 service.
The G9 endpoint-level scan (POST a synthetic SSN at every endpoint) arrives
with the first upload endpoints in Phase 4; G6/G7/G10 (kernels, rule data,
field maps) arrive with Phase 3 — each with its negative test per §9.1.
