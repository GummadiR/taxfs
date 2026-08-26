# TaxFS Blueprint — the complete design

**This is the founding document for the TaxFS repository.** It is written to be
self-contained: the TaxOS repo it distills will eventually be deleted, and a
fresh engineering session must be able to build TaxFS from this document alone.
It folds in every lesson from TaxOS's ~102 numbered waves (P1–P102) — the
planned scope, the defect fixes, and the optimizations — as *design*, so none
of them has to be rediscovered by testing.

Companions (copy them into the new repo alongside this file):
`TAXFS-DESIGN-BRIEF.md` (narrative rationale), `TAXFS-HOSTING-SECURITY.md`
(security audit of the old system). Where they disagree with this document,
**this document wins**.

---

## 0. Mission and non-negotiables

TaxFS prepares e-file-READY personal tax return packages (federal + state,
Illinois first). It computes, validates, explains, and prints; it never
transmits to the IRS. Deployed on **Vercel + Supabase, multi-tenant**, with
real authentication, opened to invited testers (including a CPA in a
**read-only reviewer role**).

Non-negotiables, each earned the hard way:

| # | Rule | Origin |
|---|------|--------|
| N1 | All money math uses decimal Money; native `+ - * /` on values is lint-banned in kernel/critic source, including string concat | prevented real bugs across P-series |
| N2 | Every tax figure lives in cited, tax-year-versioned rule data; missing rule data **throws** (honesty guard) — never a default | core TaxOS invariant |
| N3 | Two independent kernels must agree on every golden return; divergence is a red build | caught arithmetic drift repeatedly |
| N4 | Every derived figure carries lineage: inputs, formula ref, rule version, human-readable steps | the drilldown/audit story |
| N5 | No LLM ever makes a tax determination. Agents transform language at the edges; judgments are deterministic code | §6 |
| N6 | Nothing becomes a fact without operator confirmation (typed re-entry for critical fields) | E.6 door |
| N7 | The gate chain compiles and runs the production app in CI before merge | P86/P87: a 1-char CSS error 500'd every page while all gates passed |
| N8 | SSNs/DOBs/names never reach the server or database (§5) | standing privacy rule, upgraded for hosting |
| N9 | Every persisted key is tenant-scoped **in the schema**, not by convention | P91: one client's save destroyed another's filing status |
| N10 | Hardcoded dollar values in kernel/critics fail the build; entities/companies are always data | standing rule |

---

## 1. The Pxx ledger — every lesson, as a design rule

TaxOS numbered its waves P1–P102. This table is the complete distillation;
after it, the numbers never need to be consulted again.

### 1.1 Planned scope that is now day-one design (build-order input, §7)

| Waves | Capability now in the base design |
|-------|-----------------------------------|
| P1–P12 | 1040 core: all five filing statuses (QSS at MFJ rates), income assembly in form order, std-vs-itemized, brackets §1(j), LTCG §1(h), SE tax with §6017 floor, Sch C expense taxonomy, §195 startup, 8829 home office, vehicle, §179/bonus/MACRS, PTC/8962, NIIT/8960, Additional Medicare/8959, 5695 solar credit, entity returns + K-1 passthrough with basis/passive cascades, IL base + Sch M + IL-4562 decoupling |
| P14–P18 | Plain-English UX: findings as what/why/how-to-fix/go-there cards; foreign income (FX conversion at a **sourced, cited rate**; §904 FTC limit) |
| P41–P45 | §469(i) rental allowance, 4797, encrypted local identity profile, combined print packet, §63(f) age/blind boxes |
| P49–P59 | IL gaps (exempt-interest add-back, age/blind exemptions, exempt-obligations cap, PTE credit), 2441/8863/8880 credits, QBI per entity, 2210 + IL-2210 penalties, 5329 Part I, §904(j) de minimis, §469(g)/(f) releases |
| P66–P69 | Silent-failure critics, carryover worksheet with auto-save, Schedule A built from components (SALT cap in the math, medical floor), 15CB nature-of-remittance, goldens as CI net |
| P93–P99 | **Full contribution validation**: HSA §223 by coverage type + §4973 excise; Traditional IRA §219 with phase-outs (incl. §219(g)(7) spouse-covered) + 8606 basis; Roth §408A MAGI + room rule; §402(g) deferrals across employers with both catch-up tiers (excess = income, not penalty); SIMPLE §408(p); SEP via Pub 560 reduced-rate worksheet + §4972; **multi-year: the active year is configuration** |
| P100–P102 | Local PDF masker (ships in-repo); prior-year return import; Tax History report (multi-year table + charts) — §7 phase 6 |

### 1.2 Defects → structural preventions (all are REQUIREMENTS here)

| TaxOS defect | Prevention designed into TaxFS |
|---|---|
| P76/P94: tie-out critic re-stated the kernel formula by hand, drifted twice (QBI, then HSA/½SE), blamed the operator | Tie-outs **consume the kernel's emitted dependency graph** and re-add its recorded inputs. There is no second copy of any formula to drift. |
| P82: blank password-style field wiped the stored SSN on save | Identity updates are field-wise patches with explicit `keep` semantics in the type; a blank means keep, by construction |
| P86/P87: CSS parse error → every page 500 while all gates green; e2e reused a stale dev server | N7 gate chain; Playwright always boots a fresh **production** build; `reuseExistingServer` allowed only by explicit env opt-in |
| P88: every button could hang forever (Next 16.2 action-stream abort; prefetch storm) | Pin framework minor versions; e2e includes a cold-session "every button returns" spec run against production; nav prefetch decisions are load-tested cold |
| P89: active-client cookie was session-lifetime; closing the browser "lost" all data | Every stored selector has an explicit lifetime; workspace selection survives restarts; an empty-looking workspace links to "your other workspaces" |
| P91: one global `profile-settings` id + delete-with-no-owner-check nuked another client's filing status | **Schema-level**: composite PKs `(taxpayer_id, …)` everywhere (§4); settings are a real table, not a magic source row |
| P92: SSN printed empty — comb field maxLength 9 vs dashed input; readback test used unrealistic dashless data | Field-map tests use **realistic operator input**; fill helpers normalize per field type; every mapped field verified by stamp-flatten-render, never by name |
| P80 lesson | Never infer a PDF field from its name/position — stamp, flatten, render, read back |
| P55 lesson | A computation without an intake path is dead code: every new kernel input ships with its entry row + UI in the same change |
| P am-I-stuck class (Gate spinner, File It) | Latency budget §3; long actions report progress; nav feedback is default |
| 8949 Box E misread (interleaved text layer) | Documents are read as **rendered pages** for comparisons; masked uploads rasterize ambiguous layouts |
| GitHub API rate-limit merge failures | Merges via git push; CI decoupled from merge path |

### 1.3 Optimizations adopted (from the architecture review)

1. **Serverless-safe state.** TaxOS cached a per-client session in
   `globalThis` — on Vercel every lambda has its own memory, so that design
   silently breaks. TaxFS: server state lives in Postgres only; per-request
   memoisation only; static assets (rules, form defs, templates) are
   module-scope singletons loaded once per lambda.
2. **Colocated compute and data.** Vercel region = Supabase region. This is
   the latency fix (home→cloud RTT was the real cost, measured).
3. **One cheap query for nav state** (SQL view, §4.9), not a session build.
4. **Artifacts lazy.** Package PDFs load when File It renders, never at boot.
5. **Prefetch on**, once pages are cheap. Target: section change < 100 ms.
6. **Agents re-aimed** (§6): dual-pass extraction on hard documents;
   Explanation live with citation checking; Categorization + Audit-Summary
   dropped; a Discovery agent (questions only) added.

---

## 2. System shape

```
 browser                    server (Vercel)                 Supabase
┌───────────┐   upload    ┌──────────────────┐   SQL+RLS  ┌──────────┐
│ mask.bat  │──masked──▶  │ scrub → extract  │──────────▶ │ Postgres │
│ (local)   │             │ (agents, §6)     │            │  spine   │
│           │  confirm    │ review queue     │            │          │
│ typed     │──────────▶  │ facts + lineage  │            │ storage  │
│ re-entry  │             │ kernel ∥ kernel2 │──objects──▶│ (docs,   │
│           │  drilldown  │ critics/gates    │            │  pdfs)   │
│ identity  │◀──download──│ forms/packages   │            └──────────┘
│ (client-  │   (PDF fill │                  │
│  side §5) │   in browser│                  │
└───────────┘   when hosted)└────────────────┘
```

Monorepo packages (ported from TaxOS, then evolved):

| Package | Role | Porting verdict |
|---|---|---|
| `shared` | Money, concepts, rule loaders, types | lift verbatim |
| `kernel` / `kernel2` | computation + independent mirror | lift verbatim + goldens |
| `gates` | critics + orchestrator | lift; rewrite tie-outs per §1.2 |
| `spine` | persistence | rewrite on the §4 schema |
| `forms` | field maps, fill, packages | lift; fill split client/server (§5) |
| `agents` | extraction &c. | lift harness; re-aim per §6 |
| `defense`/`compliance`/`postfiling` | risk, FBAR, est-tax, amend | lift |
| `web` | Next.js app | **rewrite** (thin: pages + actions only; domain code stays in packages) |

---

## 3. Performance budget (hard numbers, tested in CI)

| Interaction | Budget |
|---|---|
| Section navigation (warm lambda) | < 100 ms server time |
| Run gates (typical return) | < 3 s, with live progress state |
| Build package (no draft uploads — drafts are never persisted; only locked packages are) | < 5 s |
| Upload + scrub + extract (one doc) | < 20 s, progress shown |
| Cold lambda start | < 1.5 s (rules/templates lazy per §1.3.1) |

An e2e perf spec asserts the navigation budget against the production build.

---

## 4. Supabase schema (v2 — full DDL)

Improvements over TaxOS, each tied to a cause:
**(a)** composite tenant-scoped PKs (P91 class made impossible);
**(b)** `qss` allowed in filing status (latent CHECK-constraint bug found in review — QSS filers could not persist at all);
**(c)** packages/manifests are tables, not storage JSON (kills eager-restore latency; queryable history);
**(d)** settings/profile is a real table (no magic source row);
**(e)** workspace **membership with roles** — `owner / editor / reviewer` — so a CPA gets read-only access to one workspace;
**(f)** `FORCE ROW LEVEL SECURITY` everywhere + storage policies as migrations + pinned `search_path` (the three bypasses found in audit);
**(g)** the eight missing indexes;
**(h)** `agent_traces` persisted and viewable (auditability thesis);
**(i)** `history_lines` for prior-year imports;
**(j)** timestamps everywhere; audit triggers kept.

```sql
-- 0001_taxfs_init.sql  (abridged only where a column list repeats; every
-- table below FORCEs RLS and carries created_at/updated_at + audit triggers)

create table workspaces (          -- was "taxpayers"; renamed to what it is
  workspace_id  text primary key,  -- slug, server-generated
  display_name  text not null,
  created_at    timestamptz not null default now()
);

create table workspace_members (   -- (e) roles; replaces auth_user_id column
  workspace_id  text not null references workspaces,
  user_id       uuid not null,     -- auth.users
  role          text not null check (role in ('owner','editor','reviewer')),
  primary key (workspace_id, user_id)
);

create or replace function my_workspaces(min_role text default 'reviewer')
returns setof text language sql stable security definer
set search_path = public as $$                       -- (f) pinned
  select workspace_id from workspace_members
  where user_id = auth.uid()
    and case min_role when 'owner'  then role = 'owner'
                      when 'editor' then role in ('owner','editor')
                      else true end
$$;

create table settings (            -- (d) replaces the magic source row (P91)
  workspace_id text not null references workspaces,
  tax_year     int  not null,
  key          text not null,      -- 'filing_status' | 'il_exemptions' | ...
  value        jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, tax_year, key)          -- (a)
);

create table sources (
  workspace_id  text not null references workspaces,
  source_id     text not null,
  tax_year      int  not null,
  type          text not null,
  fields        jsonb not null,
  ocr_confidence numeric(5,4) not null,
  raw_ref       text not null,
  review_status text not null default 'pending'
                check (review_status in ('pending','confirmed')),
  primary key (workspace_id, source_id)              -- (a): P91 impossible
);
create index sources_by_year on sources (workspace_id, tax_year);   -- (g)

create table tax_facts (
  workspace_id   text not null references workspaces,
  fact_id        text not null,
  concept        text not null,
  tax_year       int  not null,
  jurisdictions  text[] not null,
  taxpayer_scope text not null,
  value          numeric(16,2) not null,             -- decimal, never float
  unit           text not null default 'USD',
  status         text not null check (status in ('unconfirmed','confirmed','stale')),
  confidence     numeric(5,4) not null,
  derivation_calc_id text,
  primary key (workspace_id, fact_id)                -- (a)
);
create index tax_facts_lookup on tax_facts (workspace_id, tax_year, concept);

create table fact_provenance (
  workspace_id text not null,
  fact_id      text not null,
  source_id    text not null,
  source_field text not null,
  primary key (workspace_id, fact_id, source_id, source_field),
  foreign key (workspace_id, fact_id)   references tax_facts,
  foreign key (workspace_id, source_id) references sources
);

create table calculations (
  workspace_id   text not null references workspaces,
  calc_id        text not null,
  concept        text not null,
  output_fact_id text not null,
  rule_version   text not null,
  formula_ref    text not null,
  steps          text[] not null,
  value          numeric(16,2) not null,
  primary key (workspace_id, calc_id),
  foreign key (workspace_id, output_fact_id) references tax_facts
);
create index calculations_by_output on calculations (workspace_id, output_fact_id); -- (g)

create table fact_dependencies (
  workspace_id   text not null,
  calc_id        text not null,
  input_fact_id  text not null,
  output_fact_id text not null,
  primary key (workspace_id, calc_id, input_fact_id),
  foreign key (workspace_id, calc_id)       references calculations,
  foreign key (workspace_id, input_fact_id) references tax_facts
);
create index fact_deps_input on fact_dependencies (workspace_id, input_fact_id);

create table filing_contexts (
  workspace_id  text not null references workspaces,
  tax_year      int  not null,
  jurisdiction  text not null check (jurisdiction in ('FED','IL')),
  entity_id     text,
  filing_status text not null check (filing_status in
                  ('single','mfj','mfs','hoh','qss')),   -- (b) QSS FIXED
  rule_version  text,
  primary key (workspace_id, tax_year, jurisdiction, coalesce(entity_id,'-'))
);

create table gate_runs (
  workspace_id text not null references workspaces,
  run_id       text not null,
  tax_year     int  not null,
  gate         int  not null,
  jurisdiction text not null,
  result       text not null,
  ts           timestamptz not null default now(),
  primary key (workspace_id, run_id)
);
create index gate_runs_latest on gate_runs (workspace_id, gate, jurisdiction, ts desc);

create table findings (
  workspace_id text not null references workspaces,
  finding_id   text not null,
  gate_run_id  text not null,
  critic_id    text not null,
  severity     text not null,
  payload      jsonb not null,
  primary key (workspace_id, finding_id),
  foreign key (workspace_id, gate_run_id) references gate_runs
);
create index findings_by_run on findings (workspace_id, gate_run_id);   -- (g)

create table packages (            -- (c) manifests OUT of object storage
  workspace_id  text not null references workspaces,
  package_id    text not null,
  tax_year      int  not null,
  version       int  not null,
  status        text not null check (status in ('draft','locked','filed')),
  manifest      jsonb not null,    -- form list, validation report, versions
  supersedes    text,
  unlock_history jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, package_id),
  unique (workspace_id, tax_year, version)
);
-- artifact BYTES (filled PDFs) live in storage under
--   packages/{workspace_id}/{tax_year}/{package_id}/…  with bucket POLICIES
--   (per-workspace read via membership; write via server only) shipped as a
--   migration — never the service-role key on request paths.        -- (f)
-- Drafts are ephemeral (never persisted): P90's pile-up cannot recur.

create table registers (           -- carryovers year→year (P66/P69)
  workspace_id text not null references workspaces,
  register_id  text not null,
  kind         text not null,      -- capital_loss_st/lt, qbi, foreign_tax...
  tax_year     int  not null,
  amount       numeric(16,2) not null,
  primary key (workspace_id, register_id)
);

create table history_lines (       -- (i) prior-year imports (P101/P102)
  workspace_id text not null references workspaces,
  tax_year     int  not null,
  line         text not null,      -- 'total_income' | 'agi' | 'total_tax'...
  value        numeric(16,2) not null,
  source_id    text,               -- the masked prior-year return doc
  primary key (workspace_id, tax_year, line)
);

create table agent_traces (        -- (h) the audit thesis, made visible
  workspace_id text not null references workspaces,
  trace_id     text not null,
  agent        text not null,
  model        text not null,
  input_hash   text not null,
  output       jsonb not null,
  validation   text not null check (validation in ('accepted','rejected','retried')),
  ts           timestamptz not null default now(),
  primary key (workspace_id, trace_id)
);

create table audit_log (
  workspace_id text not null,
  seq          bigserial,
  actor        text not null,      -- auth.uid() — real now
  action       text not null,
  detail       jsonb not null,
  ts           timestamptz not null default now(),
  primary key (workspace_id, seq)
);
create index audit_by_ws on audit_log (workspace_id, seq desc);         -- (g)

-- RLS pattern, applied to EVERY table above:
--   alter table X enable row level security;
--   alter table X force  row level security;                          -- (f)
--   create policy X_read  on X for select
--     using (workspace_id in (select my_workspaces('reviewer')));     -- (e)
--   create policy X_write on X for insert /* + update, delete */
--     with check (workspace_id in (select my_workspaces('editor')));
-- App connects AS THE AUTHENTICATED USER (JWT), never as table owner.
```

**Nav-state view** (one query instead of a session build):

```sql
create view nav_status as
  select w.workspace_id,
         exists(select 1 from settings s  where s.workspace_id=w.workspace_id
                and s.key='filing_status')                als_started,
         (select count(*) from sources src where src.workspace_id=w.workspace_id
                and src.review_status='pending')          docs_pending,
         (select max(ts) from gate_runs g  where g.workspace_id=w.workspace_id) last_gates,
         (select max(version) from packages p where p.workspace_id=w.workspace_id
                and p.status <> 'draft')                  package_version
  from workspaces w;
```

### 4.1 Answer to "any schema improvements to revisit?" — yes, four beyond the audit

1. **Global text PKs were the P91 bug's enabler** — `source_id text primary key`
   let one workspace's write collide with another's. v2 composes every PK with
   `workspace_id`, so the bug class is *unrepresentable*.
2. **`qss` missing from the filing-status CHECK** — latent; a QSS filer could
   not persist a filing context at all. Fixed in v2.
3. **Package manifests as storage JSON blobs** forced the eager sequential
   download at session start (a real latency cause). v2 makes them rows.
4. **The settings-as-source-row hack** — `profile-settings` lived in `sources`
   as a fake document, which is why it collided. v2 gives settings a table.

Plus the audit items now folded in: FORCE RLS, membership-based policies with
a reviewer role, storage policies as migrations, pinned `search_path`, the
eight indexes, persisted agent traces.

---

## 5. Identity (SSNs, DOBs, names, address)

Rule N8, hosted form: **identity never reaches the server.**

- Stored in the **browser** (IndexedDB), encrypted with a key derived from an
  operator passphrase (Argon2id → AES-256-GCM). Per workspace.
- PDF fill for identity fields happens **client-side**: the server serves the
  computed, locked package with identity fields EMPTY; the browser fills
  name/SSN/DOB boxes at download (pdf-lib runs fine in-browser). Comb fields
  get digits-only normalization (P92).
- Local/dev mode may keep the TaxOS encrypted-file store; same interface.
- Testers and the CPA use **synthetic identities** by default; the UI labels
  real-identity entry as local-only until the client-side path ships.
- The masker (`mask.bat`, ported as `tools/mask/`) remains the gate for any
  real document leaving the operator's machine.

---

## 6. Agents (revised roster)

Definition here: **agent = prompt builder + parser + schema validator +
semantic validator + routed model**, in a harness that owns
call → parse → schema check → semantic check with reject-and-retry. No
tool-calling; no agent reads or writes state; every call lands in
`agent_traces` and is viewable in the UI.

| Agent | Status | Design |
|---|---|---|
| **Extraction** | live | Aimed at HARD documents: per-lot 1099-B/8949 rows, K-1 boxes *and footnotes*, consolidated 1099s, prior-year returns (`history_lines`), 15CA/15CB. **Dual-pass on critical fields**: two independent extractions must agree or the field is flagged, mirroring the dual-kernel idea. Confirmation UI shows the **bounding region highlighted on the rendered page**. Routing by document complexity (small model for W-2/1099-INT; frontier model for K-1/consolidated). |
| **Explanation** | live | Paraphrases lineage/findings. Citations are machine-checked against the rule store; a citation to a nonexistent rule rejects the output; verbatim rule text returned alongside. |
| **Discovery** *(new)* | live | Cross-document and cross-year prompts: "box 12 W present — no 5498-SA uploaded"; "6 interest payers last year, 2 this year." Emits **questions only**, never numbers; cannot write anything. |
| **Interview** | deterministic | The gap report decides what to ask; template phrasing is fine. Revisit only if phrasing becomes a real complaint. |
| Categorization | **dropped** | Only meaningful with live Sch C bookkeeping; re-add if that ships. |
| Audit summary | **dropped** | 1:1 fidelity + fixed ordering ⇒ a template does it with zero risk/cost. |

---

## 7. Build order (phases; each ends green on the full gate chain)

1. **Skeleton + gates.** Monorepo, lint (incl. money-lint), typecheck,
   production build, unit, Playwright vs production build, CI on every push.
   *Nothing else lands until this is enforced.*
2. **Auth + tenancy.** Supabase Auth; §4 schema; membership roles; FORCE RLS;
   storage policies; the two-user isolation proof test (login as A and B,
   assert each sees only their rows — in CI forever).
3. **Port the core.** `shared`, `kernel`, `kernel2`, 42 goldens, divergence
   suite; then `gates` with graph-derived tie-outs; then `forms` + field-map
   verification harness.
4. **Spine v2 + app.** Stateless server per §1.3.1; nav view; upload → scrub →
   extract → confirm → facts; Review with drilldown; Gates board; File It with
   ephemeral drafts + locked packages as rows.
5. **Identity client-side** (§5) + e2e print-package proof with synthetic
   identity, byte-level PDF assertions.
6. **History + comparison.** Prior-year import via extraction into
   `history_lines`; the multi-year report (2021→current, charts); projection
   column only when a cited next-year rule release exists.
7. **Agent upgrades.** Dual-pass extraction, Discovery, region highlighting,
   complexity routing.
8. **Hardening for testers.** Rate limits, upload caps, serverless temp dirs
   for OCR cache, agent-trace viewer, invite flow for the CPA reviewer role.

Coverage beyond this list continues from the §1.1 matrix (known gaps: Social
Security worksheet, 8889/8606 official templates, per-spouse W-2 attribution,
Sch B payer detail, 1116 per-country rows, 6251/AMT) — worked **in matrix
order, not discovery order**.

---

## 8. Working agreements (how the repo is run)

- Trunk-based; short-lived branches, deleted on merge. CI green required.
- Commits reference the phase (`F2:`) — no more opaque P-numbers; an
  `docs/CHANGELOG.md` entry per merged change, one line each.
- `docs/PLAN_OF_RECORD.md` is authoritative scope; updated in the same PR as
  any scope change. Requirements never go stale by construction.
- Defect fixes are labeled `fix:` and each adds a regression test plus, when
  structural, a row in the §1.2 table of this document.
- Tests and goldens are named by **subject**, never by wave number.

---

## 9. The enforcement catalog — Way-2 guardrails, and where each one lives

This section exists to answer one question permanently: *"where is the fix,
and does it still bind code written later by someone who never read this?"*

A guardrail counts as **Way 2** only if it is checked automatically on every
change, forever, with no human or AI memory involved. Anything that depends on
remembering is Way 1 and belongs in §1.2 as guidance, not here.

| # | The mistake | Where the wall lives | What physically happens |
|---|---|---|---|
| G1 | One workspace's write touching another's data (the P91 class) | **The database itself**: every primary key is composed with `workspace_id`; RLS is FORCEd on every table | The INSERT/UPDATE is refused by Postgres. Not by app code — by the database engine. |
| G2 | A user reading another user's rows | **The database**: membership-based RLS policies, FORCE RLS, no owner-role connections from the app | The query returns zero rows regardless of what the app code asks for |
| G3 | Sloppy money math (floats, native `+`/`/`) in tax code | **The lint rule**, run by CI on every push | The build fails; the code cannot merge |
| G4 | A hardcoded dollar figure or company name in kernel/critic code | **Lint + audit script**, run by CI | The build fails |
| G5 | A change that breaks the real app while unit tests stay green (the P86 CSS class) | **CI**: the pipeline compiles the production build and runs e2e against it on every push | The pull request turns red; merge is blocked |
| G6 | The two kernels drifting apart | **CI**: the divergence suite runs all goldens through both kernels | Red build on any disagreement |
| G7 | Computing a season on missing/stale rule data | **The kernel's honesty guard**: missing rule data throws at runtime, loudly | The return refuses to compute rather than silently using a default |
| G8 | A model's output entering the return unreviewed | **The review-queue door**: the only code path into `tax_facts` requires operator confirmation | There is no API that writes a fact from agent output directly |
| G9 | An SSN reaching the server or database | **The architecture**: hosted identity is browser-only; server code has no identity fields to receive; plus a CI scan test posting a fake SSN at every endpoint and asserting it is rejected/absent from storage | Nothing server-side can store what it never receives |
| G10 | A PDF field mapped by guesswork (the P92 class) | **The field-map guard test**: every mapped field must exist in the template; identity fill tested with realistic dashed input | Red build on any unverifiable mapping |

### 9.1 Guardrail tests — the proof of permanence

Each guardrail above ships with a **negative test**: a test that *attempts the
forbidden thing* and passes only when it is refused.

- G1/G2: log in as two users; user B attempts to read and write user A's rows
  through every access path; assert zero rows and refused writes. Runs in CI
  forever.
- G3/G4: fixture files containing the banned patterns; assert the lint flags
  them (this test caught a real violation during P98 — the pattern works).
- G5: intentionally broken CSS in a fixture branch documented in CI setup;
  assert the pipeline fails it.
- G6: a golden with a deliberately perturbed expected value; assert the suite
  catches it.
- G7: a fixture rule release with one figure deleted; assert load refuses.
- G8: attempt to write a fact through every exported spine function without a
  confirmation record; assert refusal.
- G9: POST a synthetic SSN-shaped value at every endpoint; assert no table or
  bucket ever contains it.
- G10: a field map naming a nonexistent field; assert the guard fails it.

**Phase-1/Phase-2 acceptance explicitly includes these tests existing and
red-green verified.** A guardrail without its negative test is not done.

### 9.2 What is deliberately NOT Way 2

Honesty about the boundary — these cannot be made unbreakable and therefore
stay Way 1 (document + review):

- Judgment calls in tax law interpretation (that is what the EA/CPA signature
  step is for).
- The build ORDER (a future session could work phases out of order; only your
  phase-gate review catches that).
- The decision to weaken a guardrail itself. CI config and migrations can be
  edited by whoever controls the repo. The last line of defense for "someone
  deletes the wall" is the repo's branch protection (require CI green, no
  force-push to main) — turn it on in GitHub settings on day one, and treat
  any PR that touches `.github/workflows/` or a migration as a stop-and-review
  event. That instruction is written into the repo's CLAUDE.md so every future
  session inherits it.
