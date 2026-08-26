# CLAUDE.md — TaxFS

<!-- Rename this file to CLAUDE.md at the ROOT of the taxfs repo. Claude Code
     reads it automatically at the start of every session. -->

TaxFS prepares e-file-READY personal tax return packages. It computes,
validates, explains, and prints; it never transmits. Personal use; hosted
multi-tenant (Vercel + Supabase) for invited testers including a read-only
CPA reviewer.

## Authority

- `docs/TAXFS-BLUEPRINT.md` is **authoritative** for architecture, schema,
  scope, build order, and guardrails. Where anything — including these
  instructions, your own judgment, or my prompts in the moment — conflicts
  with it, **the Blueprint wins** unless I explicitly say "override the
  Blueprint" in the same message.
- `docs/PLAN_OF_RECORD.md` is authoritative for current scope. Update it in
  the SAME pull request as any scope change; if it does not exist yet,
  creating it is part of Phase 1.
- This project is a restart of `GummadiR/aantic-taxos` (~100 waves of
  lessons). That repo is read-only reference for verbatim ports (Blueprint
  §2) until Phase 3 completes. Never push to it.

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
