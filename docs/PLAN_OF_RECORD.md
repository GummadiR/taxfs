# TaxFS — Plan of Record

Authoritative current scope (CLAUDE.md: update this file in the SAME PR as
any scope change). Architecture/schema/guardrails: `TAXFS-BLUEPRINT.md`.

## Status

**Phase 1 (Blueprint §7.1) — built, awaiting operator review.**
Nothing beyond Phase 1 has been started.

## In scope now

- Monorepo skeleton: pnpm workspace; `packages/shared` (stub), `packages/kernel`
  (placeholder anchoring the money-lint scope), `apps/web` (thin Next.js shell).
- The full gate chain, local and in CI on every push:
  `lint (incl. money-lint) → audit:values → typecheck → production build →
  unit → e2e against that production build`.
- §9.1 negative tests applicable to Phase 1: G3 (money-lint), G4 (hardcoded
  values), plus the e2e server-reuse guard (P86 class). Each gate additionally
  proven by one deliberate break, recorded in `GATE-PROOFS.md`.

## Deferred to their phases (not started)

- Phase 2: Supabase Auth, §4 schema, FORCE RLS, isolation proof (G1/G2/G9).
- Phase 3: verbatim ports — shared/kernel/kernel2 + 42 goldens (G6/G7),
  gates with graph-derived tie-outs, forms + field-map harness (G10).
- Phases 4–8 per Blueprint §7.

## Operator decisions on record

- Supabase/Vercel region: **NOT YET SET** — the kickoff message carried a
  literal `<YOUR REGION>` placeholder. Blocks Phase 2, not Phase 1.
- Testers use synthetic identities only until the client-side identity path
  (Blueprint §5) ships.

## Blueprint concerns raised and awaiting operator answer (deviation protocol)

1. **§4 `filing_contexts` PK** uses `coalesce(entity_id,'-')` inside
   `primary key (...)` — Postgres does not allow expressions in a PK
   constraint, so the DDL as written will not apply. Proposed fix for
   Phase 2: `entity_id text not null default '-'` (or a generated column)
   with a plain composite PK. Semantics unchanged.
2. **§9.1 G5 negative test** ("intentionally broken CSS in a fixture branch")
   cannot be a permanently-running in-repo test — a branch that must fail CI
   would sit red forever. Phase 1 substitutes: the deliberate-break proof
   recorded in `GATE-PROOFS.md` + a standing e2e assertion that the parsed
   stylesheet is actually applied. Flagged as a §9.2-style boundary.
