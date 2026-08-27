# Tax years — adding a season, and back-testing one you already filed

The active year is **configuration, not code**. `TAXFS_TAX_YEAR` (default 2025)
selects the season; every figure, form definition, field map and PDF template
resolves by that year. Nothing about 2025 is hardcoded in the kernel — the
kernel is year-agnostic logic over cited, versioned data.

## What is year-scoped

| Path | What it holds |
|---|---|
| `rules/fixtures/<year>.FED.1.0.json` | Federal figures — brackets, standard deduction, credit thresholds, contribution limits — each cited |
| `rules/fixtures/<year>.IL.1.0.json` | Illinois figures |
| `rules/fixtures/<year>.SYSTEM.FED/IL.json` | Platform parameters that the IRS does not publish (critic thresholds, authority grades) |
| `rules/fixtures/forms/<year>.FORMS.FED/IL.json` | Form/line definitions |
| `rules/fixtures/pdf/<year>.PDF-FIELDMAP.json` | Line → AcroForm field, per form; also names each template path |
| `rules/fixtures/schemas/<year>.*.STUBXSD.json` | Schema validation stand-ins |
| `rules/fixtures/<year>.BIZRULES.json` | Reject-rule checks |
| `templates/pdf/<year>/FED/*.pdf`, `templates/pdf/<year>/IL/*.pdf` | The **official** government PDFs |

**A missing year fails loudly.** Setting `TAXFS_TAX_YEAR=2031` with no 2031
release produces:

```
No rule release for tax year 2031: missing rules/fixtures/2031.FED.1.0.json.
Author the 2031 release files (with citations) before setting TAXFS_TAX_YEAR=2031.
```

That refusal is deliberate. Computing one season on another season's figures is
never an option, and silence would be the worst possible failure here.

## Adding a season (e.g. 2026)

New **numbers** need no engineering. New **law** does — and arrives as an
ordinary rule-data-guarded change to the kernel.

1. **Author the rule releases.** Copy the prior year's `<year>.FED.1.0.json` and
   `<year>.IL.1.0.json`, then replace every figure from the IRS/IDOR sources —
   the inflation-adjusted Rev. Proc. (brackets, standard deduction), the
   retirement-limit Notice, the IL instructions. Update `_meta.verified_against`
   to cite exactly what you used. Every figure you have **not** yet sourced goes
   in `_meta.pending_verification` with a note; do not guess one.
2. **Copy the SYSTEM, FORMS, PDF-FIELDMAP, BIZRULES and stub-XSD files** for the
   new year, adjusting anything the forms changed.
3. **Download that year's official PDFs** into `templates/pdf/<year>/FED/` and
   `templates/pdf/<year>/IL/` (irs.gov/pub/irs-pdf and tax.illinois.gov). Point
   the field map's `template_path` entries at them.
4. **Verify every mapped field still resolves.** The IRS renumbers fields
   between years — `f1_14[0]` in one year is not `f1_14[0]` in the next. The
   coverage guard (`packages/forms/test/field-map-coverage.test.ts`) fails the
   build for any mapped field that does not exist in the new template. Never
   infer a field from its name or position: stamp, flatten, render, read back.
5. **Add goldens for the new year** — the existing ones stay pinned to the
   releases they were verified against; a new season adds tests rather than
   mutating old ones.
6. **Set `TAXFS_TAX_YEAR=<year>`** and run `pnpm gates`.

If the law changed (not just the numbers), the kernel needs the new mechanic
too — that is a normal change with its own goldens, guarded by rule data as
everything else is.

## Back-testing a year you already filed (2024, 2023, …)

This is the **strongest validation available**, and better than any synthetic
test: a professionally prepared or already-filed return is an external oracle
produced with no knowledge of TaxFS. The predecessor project's
`BACKTEST-2022` record found four mechanics that golden returns alone had
missed — oracles find gaps; goldens only pin them.

The mechanism is identical to adding a future season: author that year's cited
releases and drop that year's official PDFs. Going backwards is easier, because
every figure is final and published rather than newly announced.

Then:

1. Set `TAXFS_TAX_YEAR=2024`, create a workspace for the back-test.
2. Enter the same source values your filed return used — W-2 boxes, 1099s,
   payments. Confirm each on Review, exactly as a real return.
3. Run the gates and compare **line by line** against your filed return:
   total income, AGI, taxable income, total tax, payments, refund or owed —
   plus every schedule the return carries.
4. Record the comparison as `docs/reviews/BACKTEST-<year>.md`, listing every
   difference and its explanation. A difference is one of three things:
   - **a TaxFS defect** — fix it, and add a golden so it cannot return;
   - **a deliberate divergence** — record it as a capability gap, never hide it;
   - **a preparer choice** — an election your CPA made differently; note it.
5. Pin an **anonymized** golden from the back-test so CI keeps it forever.
   Names, SSNs, EINs and addresses never enter the repo — dollar amounts do,
   because they are the test.

Two years of clean back-tests for a form family is the bar for treating it as
production-ready (Blueprint §4).

## Cross-year work that does not exist yet

One session prepares ONE year. Amending a prior year from within a later one,
and automatic carryover hand-off between seasons, are recorded gaps — the
registers that make them possible exist in the schema, but the workflow does
not. Prior-year figures reach the current return today through the History
page, entered deliberately.
