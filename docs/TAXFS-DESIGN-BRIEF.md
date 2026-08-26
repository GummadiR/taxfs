# TaxFS — design brief (carried forward from TaxOS)

**Purpose.** TaxOS reached ~28,500 lines across 10 packages through ~100
numbered waves. Most of those waves were not "new ideas" — they were
requirements that should have been in the design, plus defects found by the
operator during testing. TaxFS starts from the finished picture: the
requirements are designed in, and the defect classes are prevented
structurally rather than patched.

This document is the handoff. It is written to be read by a fresh session
with no memory of the TaxOS work.

---

## 1. Why start over

| Measured on TaxOS | |
|---|---|
| Source | ~28,500 LOC, 10 packages + Next.js app |
| Waves | ~100, numbered P1–P102 |
| `P##` references in code comments | 827 across 144 files |
| Tests/goldens named by wave number, not subject | 30 tests, 42 goldens |
| Index explaining any wave | none |
| `docs/REQUIREMENTS.md` last updated | ~40 waves before the end |
| Branches never deleted | 50 local / 101 remote |

Two different failure classes share one numbering scheme, which is why the
history reads as an undifferentiated pile:

- **Scope that should have been designed in** — the whole retirement/HSA
  contribution subsystem, multi-year support, Schedule A, Illinois credits,
  the penalty forms. All enumerable up front from the form structure.
- **Defects shipped and then found by the operator** — SSN overwritten on
  save, a stylesheet that 500'd every page, buttons that spun forever, the
  active-client cookie dying with the browser, one client's save destroying
  another's filing status, SSN boxes printing empty.

The second class is the more serious one and section 5 exists to prevent it.

---

## 2. Carry over unchanged — these earned their place

1. **Money is decimal; native `+ - * /` is banned by lint** in kernel and
   critic source, including string concatenation. Caught real bugs.
2. **Rule data is tax-year versioned, cited, and honesty-guarded.** Every
   figure lives in `rules/fixtures/<year>.*.json` with a `verified_against`
   citation. When facts call for a computation and the rule data is missing,
   the kernel **throws** — it never substitutes a default. Do not weaken this.
3. **Dual kernel.** `kernel` builds the lineage graph; `kernel2` is an
   independent straight-line restatement. Divergence on any golden is a red
   build. This caught arithmetic drift repeatedly.
4. **Fact spine with provenance.** Every fact is
   `(taxpayer, year, concept, value, provenance[])`; derived facts carry
   inputs, formula ref, rule version, and human-readable steps. The drilldown
   UI is free once this exists.
5. **Critics as pluggable lenses, gated by stage.** ~26 critics across IRS /
   ACCOUNTANT lenses. Keep the shape.
6. **Goldens + divergence suite as the CI net.** 42 hand-verified returns.
7. **PDF field-map verification method.** Never infer a field's meaning from
   its name or position: stamp each AcroForm widget with its own index,
   flatten, render, and read where each landed. This is the only reliable way.
8. **Identity is local-only, encrypted, never in the cloud.** Key in
   `.env.local`, no plaintext fallback, tests use fake SSNs only.
9. **The local PDF masker** (`mask.bat`) — masks SSNs/EINs/birth dates/named
   strings before any document is shared, and refuses to emit a file that
   still leaks.

---

## 3. Architecture changes

### 3.1 Latency — the biggest one

**Diagnosed, not guessed.** On the operator's machine every section change
costs multiple internet round trips:

- the root layout is `export const dynamic = 'force-dynamic'` — nothing is
  ever cached;
- every page render resolves a session; a cold session performs 6+ awaits;
- **the database is remote (Supabase)** — each of those awaits is a network
  hop from the operator's home machine;
- a cold session also **lists and sequentially downloads package snapshots**
  from object storage before any page can render;
- the sidebar badges (`getNavStatus`) and the client list run in the layout,
  so they execute on *every* page;
- link prefetching was disabled (it had to be, to stop a Next 16.2 action
  hang), so no navigation is ever warm.

In a sandbox with no `DATABASE_URL` the same pages render in 27–160 ms. The
gap is entirely network and per-request work.

**TaxFS decisions:**

1. **Local-first storage.** This is a single-user, personal-use,
   non-transmitting application. The database should be **local** (SQLite or
   a local Postgres), not a cloud service on the hot path. Cloud sync, if it
   ever exists, is an explicit backup action — never a page-render dependency.
2. **Load static things once per process, not per session.** Rule sets, form
   definitions, PDF templates, capability registry and capture rules cannot
   change between requests. Module-scope singletons, loaded on first use.
3. **Never restore artifacts eagerly.** Package snapshots load only when the
   File It page actually needs them.
4. **One cheap read for navigation state**, not a full session build.
5. **Request-scoped memoisation** so a single render never repeats a query.
6. **Re-enable prefetching** once a page render is local and cheap.

**Target: a section change under 100 ms, no spinner needed.**

### 3.2 Tie-outs must be derived, not restated

Two identical failures (a missing QBI term, then a missing HSA/½SE term)
happened because the Gate-4 tie-out critic **re-states the kernel's formula
by hand** and drifts whenever the kernel gains a term. The operator was shown
"you have a $29 discrepancy" for a defect that was ours.

In TaxFS the tie-out consumes the kernel's **own emitted calculation graph**
(each derived fact already carries its inputs) and re-adds those. A new
deduction then cannot desynchronise the check by construction.

### 3.3 Scoped keys by construction

Three separate production bugs were the same root cause — a stored key that
was not properly scoped or owned:

- the filing-identity save wrote a blank over a stored SSN;
- the active-client cookie had no lifetime, so closing the browser silently
  dropped the operator into an empty workspace that looked like data loss;
- the Get Started election used **one shared record id for all clients**, and
  a delete-by-id with no owner check, so saving in one workspace destroyed
  another client's filing status — the return then silently recomputed as
  SINGLE instead of MFJ.

TaxFS: every persisted key is a typed `(tenant, year, kind)` tuple; there is
no API that can write outside the current tenant; "blank means keep" is
explicit in the type rather than a convention in one handler.

### 3.4 The gate chain must compile and run the real app

A one-character CSS error (an unescaped `]` in a Tailwind arbitrary value)
failed the whole stylesheet to parse and returned **HTTP 500 on every page** —
and every gate passed. `tsc` does not read CSS; no unit test loads the
stylesheet; the critics reason about source and never run a build; and the
end-to-end suite was reusing a dev server started *before* the edit, so 61
specs passed green against stale styles.

TaxFS gate chain, in order, non-negotiable:

```
typecheck  →  production build  →  unit tests  →  e2e against that build
```

Plus CI on every push, so this cannot depend on discipline.

### 3.5 Package shape (keep, with one split)

```
shared     Money, concepts, rule loaders, types      (2.7k)
kernel     lineage/emitter/DAG, all tax computation  (3.5k)
kernel2    independent mirror                        (1.0k)
gates      critics + orchestrator                    (2.2k)
spine      persistence, facts, provenance            (1.9k)
forms      PDF fill, field maps, package build       (1.9k)
agents     document extraction                       (1.4k)
defense    risk, FBAR, estimated tax                 (1.1k)
compliance / postfiling                              (1.4k)
web        Next.js app                              (11.5k)
```

The web app is 40% of the codebase. Split presentation from server logic:
`server/` in TaxOS grew to hold session construction, queries, actions, PDF
packet assembly, scrubbing, masking and identity — several of those are
domain packages wearing a web coat.

---

## 4. Requirements designed in from day one

The coverage matrix below is what TaxOS reached only at wave ~99. TaxFS
starts here, and the matrix drives the build order instead of testing
discovering gaps.

**Federal core.** Filing status (all five, QSS at MFJ rates), income
assembly in 1040 order, Schedule 1 adjustments, standard vs itemized
(Schedule A with the SALT cap regime and the medical floor), QBI, §1(j)
brackets with §1(h) preferential capital-gain treatment, NIIT and Additional
Medicare, credits (2441, 8863, 8880, CTC, 1116/FTC with the §904(j)
election, 8962/PTC), Schedule 2 other taxes, payments, refund/owed, Form
2210.

**Capital.** Schedule D / 8949 lot netting, wash-sale add-back, the
§1211(b) cap, the ST-first carryover worksheet, and the covered vs
noncovered (Box A–F) distinction — the latter matters: a misread of exactly
this cost a full round of analysis.

**Business.** Schedule C with the full expense taxonomy, SE tax with the
§6017 floor, home office, vehicle, §179/bonus/MACRS depreciation, K-1
passthrough with basis and passive cascades, §469 rules, Form 4797.

**Retirement and health accounts — present from day one, not wave 93.**
HSA (§223 limits by *coverage type*, catch-ups, employer vs direct
reconciliation, excess and the §4973 excise), Traditional IRA (§219 limits,
active-participant phase-outs including the spouse-covered range, Form 8606
basis), Roth (§408A MAGI phase-out and the room rule), elective deferrals
(§402(g) summed across employers, both catch-up tiers, excess as *income*),
SIMPLE, SEP/Solo-401(k) via the Pub 560 reduced-rate worksheet with the
§4972 excise.

**Illinois.** Base income from federal AGI, Schedule M additions and
subtractions, exemptions with the AGI disallowance, ICR property-tax credit,
Schedule CR, use tax, PTE credit, IL-2210, IL-4562 decoupling.

**Multi-year from day one.** The active year is configuration. A new season
is: author the cited `<year>.*.json` releases, drop that year's official PDF
templates, set the year. No code change for new *numbers*; new *law* is an
ordinary rule-data-guarded change.

**Still missing at handoff** (carry as known gaps, not surprises): the
Social Security taxable-portion worksheet, official 8889/8606 templates,
per-spouse attribution of W-2s at upload, Schedule B payer detail and the
foreign-account question, Form 1116 per-country rows, Form 6251/AMT, the
prior-year history import and comparison report, and the 2026 projection.

---

## 5. Defect register — classes that must not recur

| What happened | Class | Structural prevention |
|---|---|---|
| Blank form field overwrote a stored SSN | write-path | "blank means keep" encoded in the type, not a handler |
| One client's save destroyed another's filing status | scoping | tenant-scoped keys by construction |
| Active-client cookie died with the browser | persistence | explicit lifetimes on every stored selector |
| Unescaped `]` in CSS 500'd every page | verification | production build inside the gate chain |
| e2e passed green against a stale dev server | verification | never reuse a server; test the mode the user runs |
| Buttons spun forever (framework action bug) | verification | e2e against a production build, cold sessions |
| SSN printed empty — comb field capped at 9 chars | forms | field-map verification, realistic input in tests |
| Tie-out critic drifted from the kernel twice | design | derive the check from the kernel's own graph |
| Exchange-rate assumption unverified | data | source every rate; never infer a method from a number |

---

## 6. What to lift from TaxOS

Highest value first: `shared` (Money, concepts, rule loaders) → `kernel` +
`kernel2` → the 42 goldens → `gates` critics → `forms` field maps and the
verification harness → `agents` extraction → the masker. The Next.js app is
the piece most worth rewriting rather than porting, because the latency
decisions in section 3.1 change its shape.

---

## 7. First moves for TaxFS

1. Stand up the monorepo and the gate chain (§3.4) **before** any feature.
2. Port `shared` + `kernel` + `kernel2` + the goldens; get divergence green.
3. Decide storage (§3.1) and build the spine local-first.
4. Then work the coverage matrix (§4) in order — not by what testing finds.
