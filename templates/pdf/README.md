# Official form PDF templates (procurement artifacts)

The print-and-mail channel fills the **official** fillable PDFs — never
hand-drawn substitutes (IRS substitute forms must conform to Pub 1167; using
the official files sidesteps that entirely). The files are public-domain
government works and free to download; this repo folder is their landing zone.

## Layout

```
templates/pdf/<tax_year>/FED/<file>.pdf
templates/pdf/<tax_year>/IL/<file>.pdf
```

## What to download (tax year 2025)

Federal — https://www.irs.gov/pub/irs-pdf/ :

| Form | File |
|---|---|
| Form 1040 | `f1040.pdf` |
| Schedule 1 | `f1040s1.pdf` |
| Schedule 2 | `f1040s2.pdf` |
| Schedule 3 | `f1040s3.pdf` |
| Schedule B | `f1040sb.pdf` |
| Schedule C | `f1040sc.pdf` |
| Schedule D | `f1040sd.pdf` |
| Schedule E | `f1040se.pdf` |
| Schedule SE | `f1040sse.pdf` |
| Form 8949 | `f8949.pdf` |
| Form 8995 | `f8995.pdf` |
| Form 8962 | `f8962.pdf` |
| Form 8959 | `f8959.pdf` |
| Form 8960 | `f8960.pdf` |

Illinois — https://tax.illinois.gov (current-year individual forms):
IL-1040, Schedule M, Schedule ICR, Schedule IL-WIT.

Verify each download is the **2025 revision** (the year prints on the form).

## Wiring a form into the channel

1. Drop the PDF at the path above.
2. Dump its real AcroForm field names:
   `npx tsx scripts/dump-pdf-fields.ts templates/pdf/2025/FED/f1040.pdf`
3. Add the form to `rules/fixtures/pdf/2025.PDF-FIELDMAP.json`:
   `{ "template_path": "templates/pdf/2025/FED/f1040.pdf", "fields": { "1040.1a": "<field name from the dump>", ... } }`
4. Validate the whole release against the actual files:
   `npx tsx scripts/dump-pdf-fields.ts --check`
   (every mapped field must exist in its template; every form-def line the
   kernel can emit should either be mapped or consciously absent).
5. Rebuild the package on File It — the form's paper artifact switches from
   the placeholder rendering to a real filled `application/pdf`.

## Invariants

- The fill layer prints kernel-emitted values only — no math, no rounding.
- A populated line with no field mapping is a **mapping defect**: the
  package will not lock. A mailed form silently missing an amount is a
  wrong filing.
- Identity fields (name, SSN, address) are never mapped or filled — TaxOS
  does not hold them. The output PDF stays editable: type them in, print,
  sign in ink, mail.
