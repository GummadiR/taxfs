# TaxFS

Prepares **e-file-ready** personal tax return packages (federal + Illinois).
It computes, validates, explains and prints — it **never transmits**. You file
the printed package yourself.

> **Not for live filing yet.** The rule data is source-verified but carries
> `status: SOURCE-VERIFIED — pending licensed EA/CPA signature`. TaxFS shows
> this as a yellow note on the Gates Board rather than blocking. A human still
> checks the numbers before anything is filed.

## Run it on your own machine

**Once:** install [PostgreSQL](https://www.postgresql.org/download/) (any recent
version; set a password for the `postgres` user during setup) and
[pnpm](https://pnpm.io/installation) (`npm install -g pnpm`).

**Every time:**

- Windows — double-click **`start.bat`**
- macOS / Linux — `./start.sh`

The launcher updates the code, installs dependencies, prepares the database
(first run creates it and applies the migrations), builds, and starts the app
at **http://localhost:3000**. Leave the window open; Ctrl+C stops it.

If your `postgres` password is not `postgres`, set it once before launching:

```bat
set PGPASSWORD=your-password
```

### Where your data lives

| What | Where |
|---|---|
| Documents, facts, calculations, packages | Your local PostgreSQL database |
| **Names, SSNs, dates of birth, address** | **Your browser only** — encrypted with your passphrase (Argon2id → AES-256-GCM), never sent to any server |
| Nothing | Any cloud, unless you deliberately configure one |

Identity is filled into the PDFs **in your browser** at download time. The
server builds every package with the identity boxes empty, because it has no
field that can receive an SSN.

## Using it

1. **Workspaces** — create one per person or business you prepare for
2. **Get Started** — filing status, IL exemptions, age/blind box count
3. **Documents** — add income documents or type values directly
4. **Review** — confirm every value (nothing counts until you do), drill into
   any computed line to see its full lineage
5. **Gates Board** — run the checks; gates 0–4 and 6 block on errors, gate 5 warns
6. **File It** — lock a package, enter your identity, download the filled PDFs
7. **History** — prior years beside this year's computed return

## Tax years

The active year is **configuration, not code**: set `TAXFS_TAX_YEAR` (default
2025). Every rule figure, form definition, field map and PDF template resolves
by year, and a year with no release files fails loudly rather than computing on
another year's numbers. See [`docs/TAX-YEARS.md`](docs/TAX-YEARS.md) for how to
add a season (and how to back-test a year you have already filed).

## Development

```bash
pnpm install
pnpm lint          # includes the money-safety rule
pnpm audit:values  # no hardcoded dollar figures in kernel/critic code
pnpm typecheck
pnpm build         # production build (fails on any build-output error)
pnpm test          # unit + database suites
pnpm e2e           # Playwright against the production build
pnpm gates         # all of the above, the merge gate
```

The database suites need a PostgreSQL admin URL:
`TAXFS_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres`.

`main` is protected: every change goes branch → CI → PR → merge.

## Documents

| File | What |
|---|---|
| `docs/TAXFS-BLUEPRINT.md` | **Authoritative** — architecture, schema, scope, guardrails |
| `docs/PLAN_OF_RECORD.md` | Authoritative current scope and known gaps |
| `docs/TAX-YEARS.md` | Adding a season; back-testing a filed year |
| `docs/GATE-PROOFS.md` | Each guardrail, broken deliberately, proven to catch it |
| `docs/CHANGELOG.md` | One line per merged change |
