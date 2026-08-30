/**
 * P14 (ported from TaxOS) — human-language guides. Every finding and every
 * gate gets a four-part story: what happened, why it matters, how to fix it,
 * and where to go. This is PRESENTATION copy (not tax rules): the substance
 * of each finding still comes verbatim from the critic; these entries only
 * explain the mechanics around it in plain English.
 */

export interface CriticGuide {
  /** Why this check exists / why the item matters. */
  why: string;
  /** What the user actually does about it. */
  fix: string;
  /** Where the fix happens. */
  link: { href: string; label: string };
}

export const CRITIC_GUIDE: Record<string, CriticGuide> = {
  'IRS-DOC-MATCH': {
    why: 'The IRS computer-matches every income line against the forms payers file about you (W-2s, 1099s). An amount with no matching document is the single most common mismatch letter (CP2000) trigger.',
    fix: 'Upload the actual form behind this amount so the number traces to a document — or if you entered it manually because no form exists, this stays a note to double-check the amount against your records.',
    link: { href: '/documents', label: 'Open Documents and upload the form' },
  },
  'ACC-DOC-COMPLETE': {
    why: 'A document you uploaded produced no confirmed values — so the return cannot count anything from it. Filing while a document is sitting unread means income could be missing, which the IRS matching computers will catch.',
    fix: 'If live extraction is on, click the document’s Rescan button on Documents and confirm the values it reads on Review. If extraction is off on this machine (no API key), enter each document’s amounts through Typed entry on Documents or the Add Data cards — the stored file stays alongside as the evidence.',
    link: { href: '/documents', label: 'Open Documents — Rescan or Typed entry' },
  },
  'ACC-K1-COMPLETE': {
    why: 'A K-1 supplies the income/loss amount, but two answers exist only in YOUR records: your opening basis (what your investment was worth at the start of the year) and whether you materially participate. Without them the math must assume the most conservative case — zero basis and passive — which suspends any loss at $0.',
    fix: 'Go to Add Data → K-1 card. Enter the SAME id shown in the finding, fill ONLY the missing fields, and Save. Re-run the gates — the loss then deducts to the extent your basis and the passive rules allow, with the full math on Review.',
    link: { href: '/data', label: 'Open Add Data → K-1 card' },
  },
  'ACC-DUP-DOC': {
    why: 'Two documents of the same type report the exact same amount — very often the same statement uploaded twice. The IRS receives each form once; counting it twice overstates your income and your tax.',
    fix: 'Open Documents and compare the two files named in the finding. If they are the same statement, Remove one — the return recomputes automatically. If they are genuinely different accounts that happen to match to the cent, no action is needed.',
    link: { href: '/documents', label: 'Open Documents and compare the two files' },
  },
  'IRS-INCOME-RECON': {
    why: 'Your return’s income lines are compared against the IRS transcript (what payers actually reported). A line on one side but not the other is exactly what generates an IRS notice.',
    fix: 'If the return shows income the transcript lacks, verify it is not a duplicate. If the transcript shows income the return lacks, upload that document — the transcript also fills in over the year, so an early-season gap can be timing.',
    link: { href: '/documents', label: 'Check the transcript on Documents' },
  },
  'ACC-TIEOUT-FORM': {
    why: 'Every form total must tie out exactly to the lines that feed it — a mismatch means a calculation defect, and a return that does not internally reconcile cannot be filed.',
    fix: 'This is a computation check, not a data-entry task: re-run the gates. If it persists, one of the feeding values changed after the total was computed — the Review page lineage shows which.',
    link: { href: '/review', label: 'Open Review and inspect the lineage' },
  },
  'ACC-WITHHOLD-RECON': {
    why: 'Withholding claimed on the return must equal the withholding printed on your documents, to the dollar — the IRS verifies this against payer filings before releasing a refund.',
    fix: 'Compare each W-2 box 2 / 1099 withholding box against what was confirmed. A typo during confirmation is the usual cause — correct the value where it was entered.',
    link: { href: '/review', label: 'Open Review and check the withholding lines' },
  },
  'IRS-ROUNDNUM': {
    why: 'Real documented amounts are rarely perfectly round. A pattern of $5,000-style entries reads as estimation, and estimated deductions are a documented IRS attention pattern.',
    fix: 'Replace estimates with the exact amounts from your records ($4,987 beats $5,000). If the round number IS the true documented amount, acknowledge the finding with that reasoning — the note is what defends you.',
    link: { href: '/risk', label: 'Acknowledge with reasoning on Audit Readiness' },
  },
  'ACC-STD-VS-ITEM': {
    why: 'Standard vs itemized is a choice the tool makes for you by simple comparison — this check documents that the larger deduction was actually taken.',
    fix: 'Nothing to do when it passes. If it flags, add any missing itemizable amounts (property tax, mortgage interest) so the comparison is complete.',
    link: { href: '/documents', label: 'Add itemizable amounts via Typed entry' },
  },
  'ACC-CARRYFWD': {
    why: 'Losses and credits that carry between years must enter this year exactly as last year’s return left them. An entry in an unsupported format is being IGNORED — your tax is overstated until it is re-entered the supported way.',
    fix: 'Re-enter the amount where TaxFS applies it: capital-loss carryovers through the Add Data carryover worksheet, QBI loss through Typed entry. Then remove the old-format entry this finding points at.',
    link: { href: '/data', label: 'Open Add Data — carryover worksheet' },
  },
  'ACC-METHOD': {
    why: 'A calculation method (like a depreciation convention) must reproduce the same answer when recomputed independently — a mismatch means the number cannot be trusted.',
    fix: 'Re-run the gates; if the mismatch persists it is a defect in the calculation record, and the affected value’s lineage on Review shows the divergence.',
    link: { href: '/review', label: 'Inspect the value’s lineage on Review' },
  },
  'ACC-SANITY': {
    why: 'Bounds checks (nothing negative that cannot be, nothing above statutory caps) catch data-entry slips before they become a wrong return.',
    fix: 'Open the flagged value’s lineage to see which document fed it, and correct the source value.',
    link: { href: '/review', label: 'Open Review and correct the value' },
  },
  'ACC-FILINGSTATUS': {
    why: 'Several limits and brackets change with filing status; a status inconsistent with the data (e.g. MFS with joint documents) produces a lawful-looking but wrong return.',
    fix: 'Confirm your filing status on Get Started matches your actual situation for the year.',
    link: { href: '/get-started', label: 'Check filing status on Get Started' },
  },
  'ACC-IL-SUBTRACT': {
    why: 'Illinois starts from federal AGI and then subtracts items Illinois does not tax (retirement income, Social Security). Missing a subtraction overpays Illinois; inventing one understates it.',
    fix: 'Verify the flagged subtraction against the IL-1040 Schedule M instructions; the lineage shows which federal amounts fed it.',
    link: { href: '/review', label: 'Open the Illinois lines on Review' },
  },
  'ACC-CREDIT-FINDER': {
    why: 'This check looks for credits your data suggests you qualify for but the return does not claim (property-tax credit, education credits) — money left on the table.',
    fix: 'Read the suggestion and, if it applies, add the underlying amounts (e.g. property tax paid) through Typed entry so the credit computes.',
    link: { href: '/documents', label: 'Add the amounts via Typed entry' },
  },
  'ACC-EVID-SUFFICIENCY': {
    why: 'Some deductions demand specific contemporaneous records (mileage logs, receipts over thresholds). The amount can be right and still indefensible without the record behind it.',
    fix: 'Capture the named record type in Year-Round; if the record does not exist, consider whether the amount survives without it.',
    link: { href: '/year-round', label: 'Capture records on Year-Round' },
  },
  'IRS-AUTHORITY': {
    why: 'Positions with weak legal authority can carry penalties even when made in good faith. This grades how well-supported each position is before you file it.',
    fix: 'For a weak-authority position: disclose it (Form 8275), change it, or document why you proceed — the recorded decision is your defense.',
    link: { href: '/risk', label: 'Record the decision on Audit Readiness' },
  },
  'ACC-DEPCARE-EARNED-INCOME': {
    why: 'The dependent-care credit is limited to the LOWER-earning spouse’s earned income. Without that number the credit was computed unverified — if the lower earner made less than the care expenses, the credit is overstated and the IRS recomputes it.',
    fix: 'On Documents → Typed entry, either enter the lower-earning spouse’s earned income or, if both of you clearly earned more than the care expenses, confirm that instead. Then re-run the gates.',
    link: { href: '/documents', label: 'Open Documents → Typed entry' },
  },
  'ACC-FOREIGN-LTCG-UNDECLARED': {
    why: 'Foreign gain from property held over a year qualifies for the LOWER long-term capital-gains rates — but only if the long-term portion is declared. Without it, the whole gain is taxed at ordinary rates, usually overstating your tax by thousands.',
    fix: 'On the Add Data foreign card, fill in the long-term portion of the foreign gain (for property held over a year it is usually the entire gain) and Save. Re-run the gates and check the Schedule D drilldown on Review.',
    link: { href: '/data', label: 'Open Add Data — foreign income card' },
  },
  'ACC-CAPLOSS-CARRYOVER-MISSING': {
    why: 'Last year’s return shows unused capital losses, but this year has no carryover entered — losing them overstates this year’s gains and your tax.',
    fix: 'Use the built-in worksheet: enter the four numbers from your prior-year Schedule D and TaxFS computes and SAVES both carryovers automatically. Then re-run the gates.',
    link: { href: '/data', label: 'Open Add Data — capital-loss carryover worksheet' },
  },
  'ACC-NO-PREFERENTIAL-RATE': {
    why: 'Qualified dividends and long-term gains are taxed at lower rates (0/15/20%) than wages. This return has income eligible for those rates but everything computed at ordinary rates — a sign the qualifying details (holding period, qualified-dividend box) were not captured.',
    fix: 'Check the source documents on Documents: the 1099-DIV qualified box (1b) and any long-term gain figures should be entered. If a value is missing, enter it, then re-run the gates.',
    link: { href: '/documents', label: 'Open Documents and check the dividend/gain boxes' },
  },
  'ACC-FTC-NOT-CLAIMED': {
    why: 'Foreign tax was paid (for example on a 1099-DIV box 7, or an Indian TDS certificate) but no foreign tax credit is being claimed — you would be paying tax twice on the same income.',
    fix: 'Enter the foreign income the tax relates to on the Add Data foreign card (in US dollars); with income and tax both present, Form 1116 computes the credit. For small amounts the §904(j) election is available through Typed entry. Then re-run the gates.',
    link: { href: '/data', label: 'Open Add Data — foreign income card' },
  },
  'ACC-CONTRIB-EXCESS': {
    why: 'Retirement and savings accounts have annual contribution limits; contributing above them triggers an excise tax every year the excess stays in the account.',
    fix: 'Verify the contribution amounts against your statements. If the excess is real, withdrawing it before the filing deadline usually avoids the excise — talk this one through before filing.',
    link: { href: '/review', label: 'Check the contribution lines on Review' },
  },
  'ACC-HSA-COVERAGE': {
    why: 'HSA contributions are only deductible for months you were covered by a qualifying high-deductible health plan — a full-year deduction with partial-year coverage overstates it.',
    fix: 'Confirm your HDHP coverage months; if coverage was partial-year, the limit prorates. Correct the entered amount to the prorated figure.',
    link: { href: '/documents', label: 'Correct the amount via Typed entry' },
  },
  'ACC-HSA-DUP-SOURCE': {
    why: 'HSA contributions can arrive twice — through payroll (W-2 box 12 W) and entered manually — and counting both overstates the deduction.',
    fix: 'Keep ONE source: if the contribution came through payroll, remove the manual entry; the W-2 amount already excludes it from income.',
    link: { href: '/documents', label: 'Remove the duplicate on Documents' },
  },
  'ACC-IRA-8606': {
    why: 'Nondeductible IRA contributions must be tracked on Form 8606 — without it, the same dollars get taxed again when withdrawn.',
    fix: 'Enter the nondeductible contribution so Form 8606 carries the basis forward; your future self pays less tax for it.',
    link: { href: '/documents', label: 'Enter it via Typed entry' },
  },
};

/**
 * Computational gates 0–6 as TaxFS runs them — what each checks and what
 * pass/fail means. TaxFS gate semantics (Blueprint §4), not TaxOS's.
 */
export const GATE_GUIDE: Record<number, { what: string; pass: string; fail: string }> = {
  0: {
    what: 'Intake integrity: is the return being prepared under a valid setup — supported tax year, supported filing status, loaded and verified rule versions?',
    pass: 'Passes when the filing context matches what this release actually supports.',
    fail: 'Fails when the year/status/scope is outside the loaded rules — fix on Get Started; the tool stops rather than compute with wrong rules.',
  },
  1: {
    what: 'Source confirmation: has every value that feeds the return been confirmed by you (G8 — nothing counts until you confirm it), and is every confirmed value well-formed?',
    pass: 'Passes when every fact is typed, registered, and operator-confirmed.',
    fail: 'Fails while values await your confirmation on Review, or on malformed inputs — the message names the exact fact.',
  },
  2: {
    what: 'Profile consistency: does the DATA make sense as a tax return — every document produced values, every income line is backed by the right form, no unread uploads, deduction choice consistent?',
    pass: 'Passes when every upload is either turned into values or consciously handled, and income lines trace to their expected forms.',
    fail: 'Fails (red) on completeness gaps like an uploaded form with nothing entered from it. With extraction off, enter each document’s amounts via Typed entry or Add Data — the finding clears once the document’s values exist.',
  },
  3: {
    what: 'Rule-data validity: were the right rules applied — deduction choice, subtraction eligibility, credit qualification, limit ordering — against the loaded, source-verified rule set?',
    pass: 'Passes when every applied rule matches the loaded rule data.',
    fail: 'Fails when a rule application cannot be justified from the rule data — the finding cites the rule involved.',
  },
  4: {
    what: 'Computation & tie-outs: does the math tie out — form totals equal the sum of their lines, refund equals payments minus tax, and the independent second kernel reproduces every headline number?',
    pass: 'Passes when every total reconciles exactly and the mirror calculation agrees to the dollar.',
    fail: 'Fails on any tie-out or divergence — this is always a tool-side defect to investigate via lineage, never something to hand-adjust.',
  },
  5: {
    what: 'Advisory review: informational patterns that statistically draw IRS attention (round numbers, benchmark outliers, weak-authority positions). WARNS ONLY — a lawful return never blocks here.',
    pass: 'Clean means no attention patterns worth documenting.',
    fail: 'Warnings list items to document or acknowledge with reasoning on Audit Readiness — the documented reasoning is the defense.',
  },
  6: {
    what: 'Package readiness: can a filing package actually be produced — every required form present, every populated line mapped, package validation clean?',
    pass: 'Passes when the package builds with zero defects and validates against the schema checks.',
    fail: 'Fails when a form or mapping is missing — the finding names the form and line; the fix is usually upstream data, never hand-editing the package.',
  },
};

/** Engagement lifecycle gates 0–13 — the CPA-style checklist around the computational gates. */
export const ENGAGEMENT_GUIDE: Record<number, string> = {
  0: 'Engagement setup: deadlines, extension posture, and the engagement calendar. Not implemented yet — shown honestly rather than silently green.',
  1: 'Scope qualification: checks that everything YOUR return needs is a part of this tool that has been proven. A yellow note usually means a second independent sign-off on the year’s IRS figures is outstanding — a built-in caution, needs nothing from you.',
  2: 'Taxpayer profile: the filing context checks (computational gate 0).',
  3: 'Document completeness & carryforward continuity: everything expected arrived, and last year’s carryforwards entered unbroken.',
  4: 'Income reconciliation: inputs are valid and every income line is document-backed (computational gates 1–2).',
  5: 'Evidence & substantiation: contemporaneous records behind deductions. Not implemented yet.',
  6: 'Tax-law, limits & elections: right rules, right limits, right elections (computational gate 3).',
  7: 'Independent calculation: a fully independent re-preparation. The built-in mirror kernel covers the headline math; a true independent re-prep is not implemented.',
  8: 'Cross-form reconciliation: totals tie out across every form (computational gate 4).',
  9: 'Analytical review: the audit-readiness diagnostics (computational gate 5).',
  10: 'Filing artifact validation: the package builds clean and validates (computational gate 6).',
  11: 'Dual sign-off: a second qualified reviewer signs before lock. Human step — not implemented in-tool.',
  12: 'Final freeze & audit trail: the locked package is immutable and every input/version is archived with it.',
  13: 'Post-filing verification: after the IRS processes the return, its transcript is matched line-by-line against what was filed.',
};
