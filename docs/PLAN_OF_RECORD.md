# TaxFS — Plan of Record

Authoritative current scope (CLAUDE.md: update this file in the SAME PR as
any scope change). Architecture/schema/guardrails: `TAXFS-BLUEPRINT.md`.

## Status

**Phase 3 (Blueprint §7.3) — core ported and green; `gates` (with
graph-derived tie-outs) and `forms` (+ field-map harness) in progress.
Phase 2 built; live-project provisioning pending an operator permission
click.** Phase 1 accepted (operator: "proceed",
2026-08-26), including its three deviation flags and region = us-east-2.

## In scope now

- Monorepo skeleton: pnpm workspace; `packages/shared` (stub), `packages/kernel`
  (placeholder anchoring the money-lint scope), `apps/web` (thin Next.js shell).
- The full gate chain, local and in CI on every push:
  `lint (incl. money-lint) → audit:values → typecheck → production build
  (strict: build output containing an Error line fails even at exit 0 —
  hardening found during the gate proofs, see GATE-PROOFS.md) → unit →
  e2e against that production build`.
- §9.1 negative tests applicable to Phase 1: G3 (money-lint), G4 (hardcoded
  values), plus the e2e server-reuse guard (P86 class). Each gate additionally
  proven by one deliberate break, recorded in `GATE-PROOFS.md`.

## Phase 2 (built this session)

- `supabase/migrations/0001_taxfs_init.sql`: the full §4 schema v2 — 16
  tables, every PK composed with workspace_id, RLS ENABLED + FORCED on all,
  membership roles (owner/editor/reviewer), audit triggers, updated_at
  triggers, security_invoker nav_status view, explicit grants (anon: none).
- `0002_storage.sql`: buckets (documents, packages) + membership-scoped
  object policies as tracked migrations.
- Design decision (recorded): my_workspaces() is SECURITY DEFINER owned by
  `taxfs_definer`, a NOLOGIN BYPASSRLS role — with FORCE RLS everywhere, an
  owner-owned definer would re-enter its own policies (Postgres raises
  infinite-recursion; and UPDATE...WHERE applies SELECT policies, verified
  empirically). Bypass surface = one fixed auth.uid()-filtered function; a
  test asserts no other non-superuser role carries BYPASSRLS... (rig-level).
- G1/G2 negative suite (`supabase/test/isolation.test.ts`, 14 tests) against
  real Postgres running the real migrations, in CI via a postgres:16 service
  container: cross-user reads = zero rows on every table + storage + the
  nav view; cross-workspace writes refused by Postgres; ownership-claim
  attack refused; reviewer reads-not-writes; editor promotion unlocks;
  composite-PK coexistence (P91 unrepresentable); audit log written and
  append-only even for owners; FORCE-RLS catalog guard; no-identity-columns
  guard (G9 at schema level). Catalog + identity guards break-proven.
- Web: Supabase SSR auth acting as the authenticated user (login,
  protected /workspaces with RLS-scoped listing + workspace creation,
  sign-out); Next 16 proxy (session refresh + guard); anon-key-only env
  (.env.example documents that the service-role key never ships).

## Pending operator actions

1. Create the GitHub repo `taxfs` (github.com/new, private, no README) and
   grant the Claude GitHub App access — the App cannot create repositories
   (403). Then: push + verify CI + enable branch protection on main.
2. Approve Supabase project creation (the auto-mode permission classifier
   blocked `create_project`; cost verified $0/month, region us-east-2) —
   or create project "taxfs" in the dashboard. Then migrations 0001/0002
   apply and the live RLS smoke test runs.
3. G9 endpoint-level scan test arrives with the first upload endpoints
   (Phase 4), per the §9.1 note in GATE-PROOFS.md.

## Phase 3 progress

- Ported verbatim (namespace-renamed to @taxfs): `shared` (Money, concepts,
  rules loaders, AHC harness), `kernel`, `kernel2`, all 42 goldens, the
  divergence suite, `rules/` fixtures. Kernel test files renamed by SUBJECT
  (Blueprint §8) — no wave numbers.
- Two real defects found by TaxFS walls during the port (GATE-PROOFS.md):
  kernel2 index arithmetic (money-lint) and the hardcoded §219(g)(2)(B)
  $200 floor in both kernels (values audit) — the floor is now cited rule
  data. Goldens and divergence unchanged and green.
- `spine` ported as contracts + in-memory reference and its contract suite
  (PgSpine deliberately NOT ported — Phase 4 rewrites persistence on the §4
  schema). `gates` ported (critics, orchestrator, engagement board,
  transcript matcher; tests renamed by subject).
- **Tie-out rewrite shipped (§3.2)**: the kernel's ten form-total emit sites
  now record signed `terms` (and the zero-clamp where the form has one) on
  their Calculation; ACC-TIEOUT-FORM re-adds exactly those recorded terms
  and restates NO formula. The three historical drift regressions (QBI,
  HSA/½SE, IL add-back/PTE) pass as automatic consequences of the graph.
- Remaining in phase: `forms` + field-map verification harness (G10
  negative test).

## Deferred to their phases (not started)

- Phase 4+ per Blueprint §7 — shared/kernel/kernel2 + 42 goldens (G6/G7),
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
