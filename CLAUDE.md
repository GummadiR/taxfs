# CLAUDE.md — TaxFS

<!-- Rename this file to CLAUDE.md at the ROOT of the taxfs repo. Claude Code
     reads it automatically at the start of every session. -->

TaxFS prepares e-file-READY personal tax return packages. It computes,
validates, explains, and prints; it never transmits. Personal use; hosted
multi-tenant (Vercel + Supabase) for invited testers including a read-only
CPA reviewer.

## Authority

Order of authority, highest first. This order was rewritten after the
Blueprint outranking everything caused five screens to be REWRITTEN from
the data model instead of PORTED from the working system — each one
typechecking, passing every gate, and doing less than the screen it
replaced.

1. **What I say, now.** If I tell you something in this conversation, that
   wins. No document outranks me. (The previous version of this file said
   the Blueprint beat "my prompts in the moment" — that was wrong, and it
   is how a working system got quietly reduced.)
2. **TaxOS's actual RUNNING BEHAVIOUR** (`GummadiR/aantic-taxos`) for
   anything an operator sees or does. It is ~100 waves of earned lessons
   and it WORKS. When a TaxOS screen and a TaxFS design disagree about what
   a screen does, TaxOS wins — port it, do not reimagine it.
3. `docs/TAXFS-BLUEPRINT.md` for **architecture, schema, tenancy and the §0
   guardrails** — the things TaxOS did NOT get right. It has no authority
   over what a screen does.
4. `docs/PLAN_OF_RECORD.md` for current scope. Update it in the SAME pull
   request as any scope change.

`aantic-taxos` is read-only reference. **Never push to it.**

### Porting a screen — not optional

A screen that typechecks and passes every test can still do LESS than the
one it replaced, and nothing in a normal build can tell. So:

- **Open the TaxOS file and copy it.** Rewrite the imports and the data
  access; leave the structure, the controls, the affordances and the
  wording alone. Reimagining a screen is a rewrite, and a rewrite loses
  things — that is not a risk, it is what happened.
- `pnpm parity:screens` compares every screen's controls and buttons
  against a snapshot of TaxOS's, and runs in `pnpm gates`. A capability
  TaxFS lost must be either restored or written down, with its reason, in
  `scripts/parity-differences.json`. Adding an entry there to silence the
  check is falsifying the record.
- Never report a screen as ported on the strength of a test count. The
  evidence is the comparison: what TaxOS's screen can do, what this one
  can do, and why any difference is deliberate.

## Non-negotiables (summary — full list Blueprint §0, enforcement §9)

1. Decimal Money everywhere; native `+ - * /` on money is lint-banned.
2. Tax figures live only in cited, year-versioned rule data; missing data
   THROWS. Never a default, never a hardcoded dollar amount or company name.
3. Both kernels must agree on every golden; divergence is a red build.
4. Every derived figure carries lineage (inputs, formula ref, rule version,
   readable steps).
5. No LLM makes a tax determination. Agents transform language at the edges.
6. Nothing becomes a fact without operator confirmation.
7. Every persisted key is workspace-scoped IN THE SCHEMA.
8. Identity (SSN/DOB/names) never reaches the server or database.
9. Every guardrail ships with its NEGATIVE test (§9.1) — a test that attempts
   the forbidden thing and passes only on refusal. A guardrail without one
   is not done.

## Working rhythm

- Work in the Blueprint §7 phases. **Stop at every phase boundary** for my
  review; do not start the next phase without my explicit go.
- Deviation protocol: if you believe the Blueprint is wrong somewhere, SAY SO
  explicitly, cite the section, give the reason, and wait — never silently
  drift. Deviation with eyes open is fine; drift is not.
- STOP-AND-SHOW events (never proceed without asking): any change to
  `.github/workflows/`, any database migration, anything touching auth/RLS,
  any new external service, anything that would weaken a §9 guardrail.
- Scope discipline: build in Blueprint §1.1 matrix order. Do not add scope
  because it is adjacent; do not skip scope because it is tedious. A
  computation without its intake path + UI in the same change is dead code.

## Gates before every merge

`lint (incl. money-lint) → typecheck → PRODUCTION build → unit → e2e against
that production build`, all in CI, all green. Playwright never reuses an
existing server except by explicit env opt-in. Tests and goldens are named by
SUBJECT, never by wave/phase number.

## Evidence and honesty (hard-won — do not soften)

- Before reporting anything as done, show a verifiable result from THIS
  session: test counts, commit SHA, and for UI claims a check against the
  PRODUCTION build. Explicitly flag anything skipped, failed, or unverified.
- Never infer a PDF field's meaning from its name or position: stamp,
  flatten, render, read back. Test fills with REALISTIC operator input
  (SSNs are typed with dashes).
- Never read a tax document's meaning from its extracted text layer alone
  when comparing returns — render the page and look at it.
- When a number surprises you, verify against the primary source before
  theorizing. When you were wrong, say so plainly and correct the record.
- Real client data: NEVER commit names, SSNs, DOBs, or real addresses to the
  repo, tests, fixtures, or goldens. Tests use fake SSNs only. The operator's
  names list for the masker (`.taxos-mask.json`) is gitignored and stays
  local.

## Decisions reserved to the operator (ask; do not decide)

Supabase/Vercel region · real-vs-synthetic identities for testers · when the
CPA gets a link · when `aantic-taxos` is deleted · any §9 guardrail change ·
any spend (services, paid tiers).
