# TaxFS — Plan of Record

Authoritative current scope (CLAUDE.md: update this file in the SAME PR as
any scope change). Architecture/schema/guardrails: `TAXFS-BLUEPRINT.md`.

## Status

**ALL BLUEPRINT §7 PHASES COMPLETE (1–8).** Phase 6 COMPLETE. Phase 5 COMPLETE. Phase 4 COMPLETE (intake = demo docs + typed entry;
real uploads/scrub/extraction arrive with the Phase-7 agent re-aim, as
recorded below).**
Operator decisions this phase: Supabase live project DEFERRED (option D —
free-project cap reached; cohabiting in the live `aantic-ai` project is
under discussion, see the service-role caveat raised in session).
Phase 3 COMPLETE. shared/kernel/kernel2/goldens/
divergence, spine (contracts + reference), gates with the §3.2
graph-derived tie-outs, forms with the field-map verification harness and
its G10 negative test, official 2025 PDF templates. Phase 2 built;
live-project provisioning pending an operator permission click. Next:
Phase 4 (Spine v2 on the §4 schema + the app). Phase 1 accepted (operator: "proceed",
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
- `forms` ported whole (mapping engine, MeF-shaped XML, package lock,
  PDF fill — identity fields deliberately unfilled server-side, per §5
  they fill client-side in Phase 5) with the official 2025 templates and
  the stamp-flatten-render field-map harness; G10's seeded-negative test
  added (a fabricated field name against the real f1040.pdf is caught).

## Phase 4 progress

- Migration `0003_spine_v2.sql` — three recorded reconciliations of the
  abridged §4 DDL with the ported contract: registers rebuilt with the
  ARCHITECTURE §3.2 shape (balances, closed-immutability trigger, year-close
  roll), gate_runs + rule_version/started/consumed_fact_ids (the A.2
  staleness cascade's substrate) + a run-id sequence, calculations +
  terms/clamp_zero (§3.2 tie-out decomposition persisted). Audit triggers
  now record each row's natural id.
- `PgSpine` v2 (packages/spine/src/pg.ts): the TaxOS adapter ported to the
  §4 schema — every statement workspace-scoped (composite PKs make id-only
  lookups a cross-workspace defect), findings persist as payload jsonb,
  the taxpayer_id↔workspace_id mapping lives only at the SQL boundary, and
  a connection whose role could bypass RLS is REFUSED at connect. Ops
  helpers: ensureWorkspace / listWorkspaces / deleteWorkspaceCascade.
- The SHARED behavior-level contract suite passes 16/16 against PgSpine v2
  on the real migrations (two backends, one suite), in CI via the postgres
  service container.
- The app (apps/web, thin — domain code stays in packages): stateless
  server layer per §1.3.1 (per-request spine/connection, closed in finally;
  static releases are the only module-scope cache; nav_status view feeds
  the dashboard), Get Started (settings + filing_contexts rows), Documents
  (deterministic demo docs + typed entry — every extracted value enters
  unconfirmed and crosses the confirm door; typing IS confirmation per
  E.6), Review (confirm per fact, full lineage drilldown), Gates Board
  (orchestrator runAll over PgSpine), File It (drafts never persisted;
  locked packages as §4 rows with manifest + artifact SHA-256 hashes;
  bytes regenerate deterministically and verify against the locked hash —
  hosted object storage arrives with the tester phase).
- LOCAL OPERATOR mode: TAXFS_LOCAL_OPERATOR=1 + restricted-role database
  URL — the operator's machine and the e2e suite run the SAME spine, same
  role, same RLS walls; only the identity source differs. Refuses to boot
  when Supabase auth is also configured, so it can never become an auth
  bypass on a hosted deployment.
- The workspace cookie has an explicit one-year lifetime and is membership-
  verified on every request (P89 class).
- `agents` ported verbatim (63 evals green; the §6 re-aim — dual-pass
  extraction, Discovery, dropping Categorization/Audit-Summary — is Phase 7
  scope; live uploads + scrub land there too).
- E2E journey (9 specs, serial) against the PRODUCTION build over a fresh
  taxfs_e2e database with the real migrations: create workspace → filing
  choices → add documents → values wait unconfirmed → confirm each → gates
  0–6 green both jurisdictions → AGI drilldown shows rounded steps → File
  It locks package v1. DB prep runs inside the webServer command
  (Playwright boots the server BEFORE globalSetup — found empirically).

## Phase 5 (client-side identity, §5)

- `@taxfs/forms/identity` (client-safe subpath — the forms barrel touches
  node:fs and must never enter a browser chunk): the TaxOS-verified 1040 +
  IL-1040 Step-1 field mappings, P92 comb-digit normalization (federal SSN
  boxes take digits only; IL shows the dashed form verbatim), P81 IL DOB
  formatting, LOUD failures (a value that cannot land never silently prints
  an empty box). 5 byte-level readback tests on the official templates with
  the SSN typed WITH dashes.
- Browser vault (`apps/web/src/lib/identity/vault.ts`): Argon2id (hash-wasm,
  OWASP floor m=19MiB/t=2/p=1) → AES-256-GCM → IndexedDB, per workspace.
  No server code imports it; the server has no identity field to receive.
- `/api/artifact`: regenerates locked artifacts deterministically and
  verifies them against the hash frozen at lock. PDFs hash their CANONICAL
  content (sorted field name/value pairs) because pdf-lib embeds fonts with
  a random per-process suffix — found when the hash check itself refused a
  byte-compare across processes; a changed money line still fails loudly.
  Non-PDF artifacts hash raw bytes (byte-deterministic per D.7).
- G9 endpoint wall: SSN-shaped values in free-text server inputs are
  refused before storage (workspaces name guard; amounts are numeric-only).
- E2E proof (14 specs): browser-filled 1040 carries comb digits + name in
  the exact AcroForm fields; the server-served artifact is identity-BLANK
  with the money lines present; the vault survives reload behind the
  passphrase and refuses a wrong one; an SSN-shaped server input is
  refused; and a whole-database sweep (every text/jsonb column in public +
  storage) finds no trace of the synthetic identity after the full journey.

## Phase 6 (history + comparison)

- `/history`: §4 history_lines rows (typed prior-year entry + a synthetic
  demo import; PDF import of a real prior-year return arrives with the
  extraction phase) beside THIS return's computed headline lines (read from
  the kernel's derived facts, never re-entered). Table-first; per-line
  single-series bar charts (validated hue, direct labels, native tooltips).
- Projection honesty: a next-year column may exist ONLY when the cited
  next-year rule release is on disk; its absence renders the REASON, never
  a guessed figure. e2e-asserted.

## Phase 7 (agent upgrades, §6 roster)

- Dual-pass extraction: CRITICAL fields extract twice independently; a
  disagreement arrives FLAGGED (no value, no suggestion, both readings on
  the proposal) — the operator types from the document. Non-critical
  fields keep pass 1. A second pass that cannot parse the document flags
  every critical field.
- Discovery agent (new): deterministic detectors (box-12W-without-coverage,
  prior-year-gap, income swing vs history) phrased as QUESTIONS by the
  harnessed agent; semantic validation rejects dollar-amount assertions and
  invented topics (deterministic template fallback — a real signal is never
  silently dropped); the no-write wall is asserted by a source scan. Zero
  agent calls when nothing is missing.
- Complexity routing: document type picks the model tier
  (extraction_simple = claude-haiku-4-5 for W-2/1099-INT-class forms;
  extraction = claude-fable-5 for K-1/consolidated/1095-A/foreign), config
  defaults overridable at deps construction.
- Regions ride every proposal end-to-end (asserted); the on-page highlight
  UI lands with the live upload flow in Phase 8's hosted-tester work.
- Roster per §6: Categorization and Audit-Summary agents REMOVED (the
  gate-5 profile renders 1:1 by template); the extended e2e now exercises
  extraction → confirm → kernel → gates → explanation → discovery.

## Phase 8 (hardening for testers)

- Rate limiting: migration 0004 `request_budgets` (named to avoid collision
  with any future cohabitant project's tables) — per (workspace, user,
  action) rolling windows, taken in ONE statement, DB-backed because
  lambdas share no memory. Wired into run-gates, package lock, artifact
  regeneration and intake; refusal is loud and names the wait. RLS: a user
  touches only their own budget rows (negative-tested).
- Agent-trace persistence: PgAgentLog lands every harness call in §4's
  agent_traces (hashes and verdicts ONLY — never prompt or output text);
  /agents renders the viewer (empty state until live extraction spends
  calls).
- Discovery surfaced: the Review page shows the deterministic §6 signals
  as questions (demo W-2 now carries a box-12W FIELD with no mapped fact,
  so the coverage question is real); harnessed-agent phrasing takes over
  when a live provider is configured.
- CPA reviewer invite: owners manage the member roster from Workspaces
  (add by auth user id, reviewer = database-enforced read-only, remove);
  non-owners are refused by RLS, not by UI.
- Recorded as still-deferred with their reasons: live uploads + scrub +
  upload caps + on-page region highlighting (they are one feature — the
  live document path — and land together when hosting starts), Vercel
  deployment + Supabase cohabitation (operator-gated), real second-user
  login e2e (needs hosted Supabase auth).

## Known limitation: branch protection is configured but NOT enforced

Blueprint §9.2 asks for branch protection on `main` (require CI green, no
force-push) as the last line of defense against someone deleting the walls.
The ruleset EXISTS on GitHub and is set Active with `main` as its target —
but GitHub does not enforce rulesets on **private repositories on the Free
plan**, and it says so in a banner on the ruleset page. So today this is a
Way-1 guardrail (documented intent), not the Way-2 wall §9.2 describes.

Three ways to make it real, none taken (spend and visibility are operator
decisions): make the repo public (free, enforced immediately — the repo
holds no PII by design), pay for GitHub Pro/Team, or leave it.

**Revisit trigger:** the day anyone besides the operator gets PUSH access.
A read-only CPA reviewer does not trigger it; a second committer does.
Until then the practical wall is CI, which runs on every push and turns
the commit red — visible, though not blocking.

## Corrections

- F7's commit message states "unit 797 passed across 69 files"; the actual
  green run was 786 across 68 (the roster drop removed two eval files).
  Recorded here rather than rewriting pushed history. — shared/kernel/kernel2 + 42 goldens (G6/G7),
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
