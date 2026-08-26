# TaxFS — hosting and security appendix

Companion to `TAXFS-DESIGN-BRIEF.md`. Target: **Vercel + Supabase,
multi-tenant, opened to a CPA and other testers.** Everything below was
measured against the TaxOS codebase, not assumed.

---

## 1. The blocker that is not technical

The standing rule for TaxOS was: *personal identity data (names, SSN,
address) is NEVER saved in Supabase or any cloud — only in a local encrypted
file on the operator's machine.* The implementation honours it: identity
lives in `.taxos-identity/<client>.enc`, AES-256-GCM, key in `.env.local`,
directory `0700`, files `0600`, and no module outside the print path may read
it.

**A hosted multi-tenant app cannot keep that rule as written**, and the code
physically cannot run as-is on Vercel: the identity store calls `mkdirSync` /
`writeFileSync`, and serverless filesystems are ephemeral and read-only.
So one of three things must be chosen deliberately:

| Option | What happens to SSNs | Cost |
|---|---|---|
| **A. Client-side identity** | Stays in the tester's browser (IndexedDB, passphrase-derived key). PDFs are filled **in the browser** at download time. The server never receives it. | Preserves the rule; PDF fill must move client-side |
| **B. Cloud identity** | Encrypted column in Postgres, key in a KMS. Reverses the rule. | Real key management, breach exposure, plausibly regulatory duties |
| **C. Synthetic only** | Testers never enter real SSNs; the field is disabled outside local mode. | Free; CPA cannot test the print-and-sign path end to end |

**Recommendation: A, with C during the first test round.** Option A is the
only one that keeps the guarantee *and* ships a hosted product. It is real
work — the AcroForm fill must move to the browser — but it is bounded, and
it means a breach of the database never exposes an SSN because none is there.

## 2. Security findings — current state

Measured on the TaxOS schema and app.

### 2.1 There is no authentication at all — **critical**

`DEMO_AUTH_UID = '00000000-0000-4000-8000-000000000001'` is a hardcoded
constant. Every "client workspace" belongs to that one synthetic user, and
there is no login anywhere in the app. Deployed as-is, **anyone with the URL
is the operator** and sees every workspace.

This is the single blocker to giving anyone the link.

### 2.2 RLS is well designed — and completely bypassed — **critical**

The schema is better than expected: RLS is enabled on all 11 spine tables,
`taxpayers` is isolated by `auth_user_id = auth.uid()`, and every child table
is isolated through a `security definer` helper (`my_taxpayer_ids()`). That
design is correct.

But it does nothing at runtime, for two reasons:

1. The app connects with a **direct `DATABASE_URL` Postgres connection**, not
   as an authenticated Supabase user. `auth.uid()` is null on that
   connection, so the policies match nothing.
2. `FORCE ROW LEVEL SECURITY` is never set, so the table owner — which is
   what a direct connection typically is — **bypasses RLS entirely**.

Either one alone defeats the isolation; both are present.

### 2.3 Storage bypasses its own policies — **high**

Document and package objects are read and written with
`SUPABASE_SERVICE_ROLE_KEY`, which bypasses every storage policy. Objects are
separated only by path convention (`packages/<client>/<year>/…`). A path bug
is a cross-tenant data leak, and no migration in the repo defines bucket
policies at all — whatever exists lives untracked in the dashboard.

### 2.4 `security definer` without a pinned `search_path` — **medium**

`my_taxpayer_ids()` is `security definer` but does not `set search_path`.
Harden it; this is a standard Postgres privilege-escalation vector.

### 2.5 Other items before opening the URL

- No rate limiting on upload or compute routes; gates and OCR are expensive.
- The OCR/scrub path writes a tesseract cache with `mkdirSync` — needs a
  writable temp directory on serverless.
- Uploads are user-supplied PDFs parsed server-side; keep hard size and page
  caps and treat parse failures as expected.
- Audit rows record `auth.uid()` — worthless until real auth exists.
- No CI: nothing prevents a broken build reaching the deployed app.

## 3. Schema work — optimization and gaps

### 3.1 Indexes

Three exist and are well chosen:

```
tax_facts (taxpayer_id, tax_year, concept)
fact_dependencies (input_fact_id)
gate_runs (taxpayer_id, gate, jurisdiction, ts desc)
```

Missing, and all on hot paths or foreign keys (unindexed FKs make cascade
deletes and joins scan):

```
sources           (taxpayer_id, tax_year)
entities          (taxpayer_id)
filing_contexts   (taxpayer_id, tax_year)
findings          (gate_run_id)
findings          (taxpayer_id)
calculations      (output_fact_id)
calculations      (taxpayer_id)
audit_log         (taxpayer_id, seq desc)
```

### 3.2 Required changes for multi-tenant

1. `alter table … force row level security` on every spine table.
2. Connect as an **authenticated user**, not the owner — either the Supabase
   client with the caller's JWT, or a dedicated low-privilege role with
   `request.jwt.claims` set per request.
3. Add storage bucket policies **as migrations**, and stop using the service
   role key on request paths.
4. Pin `search_path` on `my_taxpayer_ids()`.
5. Add `auth_user_id` ownership checks to any table added later — the
   pattern is already established; follow it.

### 3.3 Latency, revisited

The design brief recommended local-first storage. **This supersedes that for
the hosted path**, and the reasoning inverts favourably: today the slowness
is a home machine talking to Supabase across the internet on every render.
With the app running on Vercel in the **same region** as the Supabase
project, that hop collapses to single-digit milliseconds. Hosting fixes most
of the latency rather than worsening it — provided the other findings in the
brief (§3.1) are also done: load static rule/form/template data once per
process, never restore package snapshots eagerly, one cheap query for
navigation state, and re-enable prefetching.

Keep local mode for the operator's own testing; it is the same code with
`DATABASE_URL` unset.

## 4. Order of work before anyone else gets the URL

1. Real authentication (Supabase Auth), replacing `DEMO_AUTH_UID`.
2. Route every query through an authenticated connection; set
   `FORCE ROW LEVEL SECURITY`; prove isolation with a test that logs in as
   two users and asserts each sees only their own rows.
3. Storage policies as migrations; retire the service-role key from request
   paths.
4. Decide identity (§1) and implement it.
5. Add the missing indexes.
6. Rate limits, upload caps, CI.
7. Only then share the link.

Steps 1–3 are the ones that make the difference between "a demo on the
internet" and "something a CPA can be given."
