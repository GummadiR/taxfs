/**
 * E.1 — Extraction agent (step-1 doc types: W-2, 1099-INT, 1099-DIV, 1099-B).
 * Classifies a document and proposes typed fields with per-field confidence
 * and bounding regions. Unreadable/unknown ⇒ manual-entry path, never a
 * guessed doc type. Wrong-year ⇒ Flag, never a silent accept.
 */
import {
  C,
  Money,
  inputHash,
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type Jurisdiction,
  type LlmMessage,
  type SemanticIssue,
} from '@taxfs/shared';
import type { ProposalInput } from './review';

export const EXTRACTION_AGENT_ID = 'extraction';

/** The uploaded document itself (live vision path). */
export interface DocMedia {
  kind: 'image' | 'pdf';
  media_type: string;
  data_base64: string;
}

export interface DocImageStub {
  doc_id: string;
  image_ref: string;
  /** Stub path: structured fixture text standing in for the scan. */
  ocr_text?: string;
  /** Live path: the document is attached as vision input (no doc text in the prompt). */
  media?: DocMedia;
  expected_tax_year: number;
}

export type ExtractionDocType =
  | 'W-2' | '1099-INT' | '1099-DIV' | '1099-B' | '1099-R' | 'SSA-1099' | 'CONSOLIDATED-1099'
  | 'K-1' | '1095-A'
  // P18 — documents that carry a return amount but are not IRS forms.
  | 'PROPERTY-TAX-BILL' | 'DONATION-RECEIPT' | 'FOREIGN-REMITTANCE'
  // P67 — Schedule A: the mortgage statement.
  | '1098'
  | 'UNREADABLE';

export interface ExtractionField {
  name: string;
  raw_text: string;
  normalized:
    | { kind: 'decimal'; value: string }
    | { kind: 'date'; value: string }
    | { kind: 'string'; value: string };
  region: { page: number; x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface ExtractionOutput {
  doc_type: ExtractionDocType;
  tax_year: number | null;
  payer: { name: string; ein_token: string | null };
  fields: ExtractionField[];
}

/** Per-doc-type field schema for the step-1 slice. */
export const FIELD_SCHEMAS: Record<Exclude<ExtractionDocType, 'UNREADABLE'>, string[]> = {
  'W-2': ['box1_wages', 'box2_fed_withholding', 'box3_ss_wages', 'box5_medicare_wages', 'box6_medicare_withholding', 'box12w_hsa', 'box17_il_withholding'],
  '1099-INT': ['box1_interest'],
  '1099-DIV': ['box1a_ordinary', 'box1b_qualified', 'box2a_capgain_distributions'],
  '1099-B': ['net_lt_gain'],
  // K-1 paper carries the entity's numbers only — basis and material
  // participation are the RECIPIENT'S facts, entered on Add Data.
  'K-1': ['box1_ordinary', 'entity_is_scorp', 'net_lt_capital_gain', 'guaranteed_payments'],
  '1095-A': ['annual_premiums', 'annual_slcsp', 'annual_aptc'],
  '1099-R': ['box1_gross', 'box2a_taxable', 'box4_fed_withholding'],
  'SSA-1099': ['box5_net_benefits'],
  // P14.9 — combined brokerage statement (one PDF carrying 1099-DIV +
  // 1099-INT + 1099-B summary sections). Field names are distinct from the
  // single-form types because CONCEPT_BY_FIELD is keyed globally.
  'CONSOLIDATED-1099': [
    'total_interest',
    'total_ordinary_dividends',
    'total_qualified_dividends',
    'total_lt_gain',
    'total_st_gain',
    'total_capgain_distributions',
    'total_fed_withholding',
    // P71 — three boxes printed on every brokerage 1099-DIV that were not
    // being read, so they had to be hand-entered off a document TaxOS already
    // had open. Exempt-interest dividends in particular are federally exempt
    // but ILLINOIS TAXES THEM, so missing the box understates the state return.
    'total_exempt_interest_dividends',
    'total_foreign_tax_paid',
    'total_sec199a_dividends',
  ],
  // A county property-tax bill / payment record (Schedule ICR).
  'PROPERTY-TAX-BILL': ['property_tax_paid'],
  // A charitable receipt or year-end giving statement (Schedule A).
  'DONATION-RECEIPT': ['charitable_contribution'],
  // India Form 15CA/15CB (or any foreign remittance/withholding certificate).
  // Amounts are in the FOREIGN currency — conversion happens downstream as its
  // own recorded calculation, never silently inside extraction.
  'FOREIGN-REMITTANCE': ['remittance_amount_foreign', 'foreign_tax_withheld_foreign', 'taxable_income_foreign', 'long_term_gain_foreign', 'remittance_date', 'currency_code'],
  // A servicer that ESCROWS reports the year's real-estate taxes on the 1098
  // itself, so the third field is not an extra — it is the reason a taxpayer
  // who never sees a county bill still has a property-tax figure.
  '1098': ['box1_mortgage_interest', 'box6_points', 'real_estate_taxes_paid'],
};

/** Which concepts each extracted field feeds (mapping is deterministic, not agent-decided). */
export const CONCEPT_BY_FIELD: Record<string, { concept: string; jurisdiction: Jurisdiction[]; critical: boolean }> = {
  box1_wages: { concept: C.WAGES, jurisdiction: ['FED', 'IL'], critical: true },
  box2_fed_withholding: { concept: C.FED_WITHHOLDING, jurisdiction: ['FED'], critical: true },
  // Boxes 3/5/6 feed SE wage-base coordination and Form 8959 (P10); box 5
  // doubles as the box-1 checksum input.
  box3_ss_wages: { concept: C.WAGES_SS, jurisdiction: ['FED'], critical: false },
  box5_medicare_wages: { concept: C.WAGES_MEDICARE, jurisdiction: ['FED'], critical: false },
  box6_medicare_withholding: { concept: C.MEDICARE_WH, jurisdiction: ['FED'], critical: false },
  // P93 — box 12 code W: employer + payroll HSA contributions. Return-level
  // (the §223 family limit is shared); NOT income — code W is already outside
  // box 1. Per-person items (elective deferrals D/E/AA/BB, box 13) stay
  // manual-entry until intake can attribute a W-2 to a specific spouse.
  box12w_hsa: { concept: C.CONTRIB_HSA_EMPLOYER, jurisdiction: ['FED'], critical: false },
  box17_il_withholding: { concept: C.IL_WITHHOLDING, jurisdiction: ['IL'], critical: true },
  box1_interest: { concept: C.INTEREST, jurisdiction: ['FED', 'IL'], critical: true },
  box1a_ordinary: { concept: C.DIV_ORDINARY, jurisdiction: ['FED', 'IL'], critical: true },
  box1b_qualified: { concept: C.DIV_QUALIFIED, jurisdiction: ['FED'], critical: true },
  net_lt_gain: { concept: C.CAPITAL_GAIN_NET, jurisdiction: ['FED', 'IL'], critical: true },
  annual_premiums: { concept: C.PTC_PREMIUM, jurisdiction: ['FED'], critical: true },
  annual_slcsp: { concept: C.PTC_SLCSP, jurisdiction: ['FED'], critical: true },
  annual_aptc: { concept: C.PTC_APTC, jurisdiction: ['FED'], critical: true },
  // 1099-R: box 2a (taxable amount) is the return line; box 1 (gross) stays
  // validation-only. Box 4 federal withholding joins the payments side.
  box2a_taxable: { concept: C.RETIREMENT, jurisdiction: ['FED', 'IL'], critical: true },
  box4_fed_withholding: { concept: C.FED_WITHHOLDING, jurisdiction: ['FED'], critical: true },
  // SSA-1099 box 5 (net benefits) — IL subtracts it via Sch M; the federal
  // taxable-portion worksheet is the kernel's job, never intake's.
  box5_net_benefits: { concept: C.SOCIAL_SECURITY, jurisdiction: ['FED', 'IL'], critical: true },
  // CONSOLIDATED-1099 summary totals. LT and ST both feed the single net
  // capital-gain concept (the kernel sums multiple facts); per-lot detail
  // stays the Add Data lots path when basis reporting needs it.
  total_interest: { concept: C.INTEREST, jurisdiction: ['FED', 'IL'], critical: true },
  total_ordinary_dividends: { concept: C.DIV_ORDINARY, jurisdiction: ['FED', 'IL'], critical: true },
  total_qualified_dividends: { concept: C.DIV_QUALIFIED, jurisdiction: ['FED'], critical: true },
  total_lt_gain: { concept: C.CAPITAL_GAIN_NET, jurisdiction: ['FED', 'IL'], critical: true },
  box2a_capgain_distributions: { concept: C.CAPITAL_GAIN_NET, jurisdiction: ['FED', 'IL'], critical: true },
  total_capgain_distributions: { concept: C.CAPITAL_GAIN_NET, jurisdiction: ['FED', 'IL'], critical: true },
  // P71 — 1099-DIV box 12: federally exempt, but Illinois adds it back
  // (35 ILCS 5/203(a)(2)(A)), so it is IL-jurisdiction too.
  total_exempt_interest_dividends: { concept: C.TAX_EXEMPT_INTEREST, jurisdiction: ['FED', 'IL'], critical: false },
  // 1099-DIV box 7. Passive-category tax on a payee statement — exactly the
  // §904(j) shape, so the kernel will ask for that election rather than
  // demanding a Form 1116 foreign-income figure the 1099 never states.
  total_foreign_tax_paid: { concept: C.FOREIGN_TAX_PAID, jurisdiction: ['FED'], critical: false },
  // 1099-DIV box 5 — REIT dividends feed the §199A deduction (8995 line 6).
  total_sec199a_dividends: { concept: C.REIT_PTP_INCOME, jurisdiction: ['FED'], critical: false },
  total_st_gain: { concept: C.CAPITAL_GAIN_NET, jurisdiction: ['FED', 'IL'], critical: true },
  total_fed_withholding: { concept: C.FED_WITHHOLDING, jurisdiction: ['FED'], critical: true },
  // P18 — non-IRS documents that still carry a return amount.
  property_tax_paid: { concept: C.IL_PROPERTY_TAX, jurisdiction: ['IL'], critical: true },
  // P72 — a donation receipt is a Schedule A COMPONENT (line 11-14), not a
  // hand-computed Schedule A TOTAL. Mapping it to C.ITEMIZED was harmless
  // while it was the only Schedule A input; after P67 added real components
  // it made the two mutually-exclusive inputs collide, so uploading a
  // donation receipt AND a Form 1098 refused to compute the whole return.
  charitable_contribution: { concept: C.SCHA_CHARITABLE, jurisdiction: ['FED'], critical: true },
  // 15CA/CB: the TDS lands in its FOREIGN currency — the kernel converts it
  // (with the arithmetic on the record) once the user supplies the exchange
  // rate on Add Data. remittance_amount_foreign stays context-only: the
  // remittance is proceeds, not the taxable GAIN, which needs the user's basis.
  // P67 — Form 1098. Box 1 is the deductible mortgage interest; box 6 is
  // points paid on a purchase, deductible in the year paid.
  box1_mortgage_interest: { concept: C.SCHA_MORTGAGE_INTEREST, jurisdiction: ['FED'], critical: true },
  box6_points: { concept: C.SCHA_MORTGAGE_POINTS, jurisdiction: ['FED'], critical: false },
  // Escrowed real-estate taxes reported ON the 1098. Same concept as a county
  // bill: Schedule A SALT federally, Schedule ICR in Illinois. NOT critical —
  // most 1098s carry no escrow figure, and a form that simply does not state
  // one must never hold up the mortgage interest that is its real payload.
  real_estate_taxes_paid: { concept: C.IL_PROPERTY_TAX, jurisdiction: ['IL'], critical: false },
  foreign_tax_withheld_foreign: { concept: C.FOREIGN_TAX_FCY, jurisdiction: ['FED'], critical: true },
  // P32 — the 15CB often carries the CA-computed taxable gain ('amount of
  // income chargeable to tax'). It proposes into the FCY income concept for
  // the user to CONFIRM (US basis rules can differ from indexed Indian
  // computations — the confirm step is where that gets checked).
  taxable_income_foreign: { concept: C.FOREIGN_INCOME_FCY, jurisdiction: ['FED'], critical: true },
  // P68 — the 15CB states the NATURE of the remittance ("Long Term Capital
  // Gains"). Without this the long-term portion could never be populated from
  // the document, and the kernel taxed the whole gain at ordinary rates. It is
  // CRITICAL: the filer must confirm it against the US holding period, which
  // is what actually governs (§1222(3)), not the foreign law's label.
  long_term_gain_foreign: { concept: C.FOREIGN_LTCG_FCY, jurisdiction: ['FED'], critical: true },
};

/** K-1 fields feed NAMESPACED concepts — the instance id derives from the
 *  issuing entity (payer), deterministically, never from the model. */
export const K1_CONCEPT_BY_FIELD: Record<string, { suffix: string; jurisdiction: Jurisdiction[]; critical: boolean }> = {
  box1_ordinary: { suffix: 'box1', jurisdiction: ['FED', 'IL'], critical: true },
  entity_is_scorp: { suffix: 'is_scorp', jurisdiction: ['FED'], critical: true },
  net_lt_capital_gain: { suffix: 'capital_gain', jurisdiction: ['FED', 'IL'], critical: false },
  guaranteed_payments: { suffix: 'guaranteed_payment', jurisdiction: ['FED', 'IL'], critical: false },
};

/** Deterministic K-1 instance id from the issuing entity. */
export function k1InstanceId(payer: ExtractionOutput['payer'], doc_id: string): string {
  const slug = payer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return slug;
  if (payer.ein_token) return payer.ein_token.replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  return doc_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
}

/** Confidence threshold below which a field is empty-with-suggestion `(tuned per doc type)`. */
export const CONFIDENCE_THRESHOLDS: Record<Exclude<ExtractionDocType, 'UNREADABLE'>, number> = {
  'W-2': 0.9,
  '1099-INT': 0.9,
  '1099-DIV': 0.9,
  '1099-B': 0.9,
  'K-1': 0.9,
  '1095-A': 0.9,
  '1099-R': 0.9,
  'SSA-1099': 0.9,
  'CONSOLIDATED-1099': 0.9,
  'PROPERTY-TAX-BILL': 0.9,
  'DONATION-RECEIPT': 0.9,
  'FOREIGN-REMITTANCE': 0.9,
  '1098': 0.9,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Response-side PII tokenization (E.0 context minimization, inbound leg).
// The outbound PII wall (llm-client) keeps identifiers out of prompt TEXT;
// with real vision the document image necessarily contains them, so the
// model's response may echo an EIN/SSN. Tokenize at parse time — BEFORE
// schema validation, before proposals, before anything downstream can see
// or persist a raw identifier. Same formatted-pattern scope as the wall
// (documented F6 limitation).
// ---------------------------------------------------------------------------

const RAW_SSN_G = /\b\d{3}-\d{2}-\d{4}\b/g;
const RAW_EIN_G = /\b\d{2}-\d{7}\b/g;

/** Deterministic, non-reversible token for an echoed identifier. */
export function piiToken(prefix: 'ssn' | 'ein', raw: string): string {
  return `tok_${prefix}_${inputHash(raw.replace(/\D/g, '')).slice(0, 8)}`;
}

/** Recursively replace any raw SSN/EIN pattern in string values with tokens. */
export function sanitizeExtractionPii(candidate: unknown): unknown {
  if (typeof candidate === 'string') {
    return candidate
      .replace(RAW_SSN_G, (m) => piiToken('ssn', m))
      .replace(RAW_EIN_G, (m) => piiToken('ein', m));
  }
  if (Array.isArray(candidate)) return candidate.map(sanitizeExtractionPii);
  if (isRecord(candidate)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(candidate)) out[k] = sanitizeExtractionPii(v);
    return out;
  }
  return candidate;
}

/** Models sometimes wrap JSON in markdown fences despite instructions. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
}

const OUTPUT_SHAPE =
  '{"doc_type":"W-2"|"1099-INT"|"1099-DIV"|"1099-B"|"1099-R"|"SSA-1099"|"CONSOLIDATED-1099"|"K-1"|"1095-A"|"1098"|"PROPERTY-TAX-BILL"|"DONATION-RECEIPT"|"FOREIGN-REMITTANCE"|"UNREADABLE","tax_year":number|null,' +
  '"payer":{"name":string,"ein_token":string|null},' +
  '"fields":[{"name":string,"raw_text":string,"normalized":{"kind":"decimal"|"date"|"string","value":string},' +
  '"region":{"page":number,"x":number,"y":number,"w":number,"h":number},"confidence":number}]}';

const FIELD_MENU = (Object.entries(FIELD_SCHEMAS) as [string, string[]][])
  .map(([t, names]) => `${t}: ${names.join(', ')}`)
  .join('; ');

/** System prompt for the live vision path (document attached, no doc text in prompt). */
const VISION_SYSTEM_PROMPT =
  'You are the document-extraction step of a personal tax tool. Classify the attached tax document ' +
  `and extract its fields. Return ONLY a JSON object (no markdown fences, no prose) shaped exactly: ${OUTPUT_SHAPE}. ` +
  `Allowed field names per doc_type — ${FIELD_MENU}. ` +
  'Extract ONLY fields from that menu — ignore every other box (state codes, addresses, control numbers, locality lines). Rules: ' +
  'normalized decimal values are plain digits with an optional dot — no commas, no currency symbols (e.g. "60000" or "60000.00"); ' +
  'raw_text is the text exactly as printed in that box; ' +
  'region is the approximate bounding box of where the value was read, in page pixel coordinates (page starts at 1) — every value must cite a region; ' +
  'confidence is your per-field read confidence in [0,1] based on print legibility; ' +
  'omit boxes that are blank on the document — never invent zero values; ' +
  'tax_year is the year printed on the form, or null if not legible. ' +
  'PRIVACY (hard rules): never output a Social Security Number in any form — omit SSNs entirely, including from raw_text. ' +
  'Never output a raw EIN: set payer.ein_token to "tok_ein_" followed by 6-10 lowercase letters/digits stable for the payer, or null if none is printed. ' +
  'K-1 rules: entity_is_scorp is 1 for a 1120-S K-1 and 0 for a 1065 K-1 (normalized decimal); guaranteed_payments only on 1065 K-1s (box 4); net_lt_capital_gain = box 8a (1120-S) / 9a (1065). ' +
  '1095-A rules: extract the ANNUAL totals row (line 33) columns A/B/C. ' +
  'CONSOLIDATED-1099 rules: a combined brokerage statement (Fidelity/Schwab/Vanguard style) with 1099-DIV, 1099-INT, and 1099-B SECTIONS in one document is doc_type CONSOLIDATED-1099 — read the SUMMARY totals, not per-lot rows: ' +
  'total_interest = 1099-INT box 1 total; total_ordinary_dividends = 1099-DIV box 1a; total_qualified_dividends = 1099-DIV box 1b; ' +
  'total_lt_gain = the 1099-B long-term NET gain/(loss) total; total_st_gain = the 1099-B short-term NET gain/(loss) total (negatives keep the minus sign); ' +
  'total_capgain_distributions = 1099-DIV box 2a (total capital gain distributions) — a SEPARATE amount from the 1099-B totals, never added into total_lt_gain and never skipped when box 2a is non-zero; ' +
  'total_fed_withholding = federal income tax withheld total across sections. ' +
  'total_exempt_interest_dividends = 1099-DIV box 12 (exempt-interest dividends) — federally tax-exempt but a STATE add-back, so never skip it; do NOT use box 13 (specified private activity bond interest), which is a subset of box 12 reported separately for AMT. ' +
  'total_foreign_tax_paid = 1099-DIV box 7 (foreign tax paid), in USD as printed — this is NOT a foreign-currency amount and must not be converted. ' +
  'total_sec199a_dividends = 1099-DIV box 5 (section 199A dividends). ' +
  'Omit any of these three entirely when the box is absent or zero. A standalone single-section form keeps its own doc_type. ' +
  'PROPERTY-TAX-BILL rules: a county/municipal real-estate tax bill or payment receipt — property_tax_paid is the TOTAL tax PAID for the year on the principal residence (sum both installments if both are shown as paid); ignore assessed values, exemptions, and prior-year balances. ' +
  'DONATION-RECEIPT rules: a charitable receipt or year-end giving statement (temple, church, nonprofit) — charitable_contribution is the total DEDUCTIBLE amount given for the tax year; exclude anything the receipt marks as goods/services received or as a non-deductible item. ' +
  '1098 rules: Form 1098 Mortgage Interest Statement. payer.name is the LENDER / recipient of the interest (the bank or servicer), never the borrower. box1_mortgage_interest = box 1 "Mortgage interest received from payer(s)/borrower(s)". box6_points = box 6 "Points paid on purchase of principal residence" — omit the field entirely when the box is blank. real_estate_taxes_paid = the REAL ESTATE / PROPERTY TAXES the servicer PAID for the year, which a lender reports either in box 10 ("Other") or in a summary block printed outside the form boxes (e.g. a line reading "REAL ESTATE TAXES PAID $11,682.34"); read it from whichever of the two states it, and OMIT the field entirely when neither does — never infer it from an escrow balance, a monthly payment, an assessed value, or box 2. Do NOT read box 2 (outstanding mortgage principal) or box 5 (mortgage insurance premiums) into any field. ' +
  'FOREIGN-REMITTANCE rules: India Form 15CA / 15CB, or any foreign remittance or tax-withholding certificate. payer.name must be the DEDUCTING INSTITUTION (bank / CA firm) or the literal string \"Form 15CA/15CB\" — NEVER the individual remitter or taxpayer name. remittance_amount_foreign is the gross amount remitted and foreign_tax_withheld_foreign is the tax deducted at source (TDS), BOTH in the document\'s own currency and NOT converted; currency_code is the ISO code as a string field (e.g. "INR"). These certificates often print BOTH a foreign-currency figure and its USD equivalent side by side — ALWAYS take the amount denominated in currency_code and NEVER the USD equivalent (an INR TDS reads like 13,42,770, not like 15,615). taxable_income_foreign = the amount of income CHARGEABLE TO TAX / taxable capital gain the chartered accountant computed on the 15CB (foreign currency; omit the field entirely when the certificate does not state it — never infer it from the remittance amount). long_term_gain_foreign = the portion of taxable_income_foreign that is a LONG-TERM capital gain, in the same foreign currency. Read the certificate\'s "Nature of remittance" / "nature of payment" line: when it says long-term capital gain (or the equivalent), set this EQUAL to taxable_income_foreign. When the certificate says short-term, or names some other kind of income (interest, dividend, rent, salary), OMIT the field entirely. Never split it yourself and never guess a portion. remittance_date = the date of remittance / sale stated on the certificate, normalized {kind:\'date\', value:\'YYYY-MM-DD\'}. Never convert currency — the exchange rate is chosen downstream. ' +
  'If the document is not one of the listed types, or is illegible, return doc_type "UNREADABLE" with empty fields — never guess.';

export const extractionAgent: AgentDefinition<DocImageStub, ExtractionOutput> = {
  id: EXTRACTION_AGENT_ID,
  buildMessages: (input): LlmMessage[] => {
    if (input.media) {
      // Live vision path: the document travels as an attachment; the prompt
      // text stays identifier-free (outbound PII wall applies to it).
      return [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Document ${input.doc_id} (${input.image_ref}). Expected tax year: ${input.expected_tax_year}. Classify and extract.`,
          attachments: [input.media],
        },
      ];
    }
    return [
      {
        role: 'system',
        content:
          'Classify the tax document and extract per-type fields as JSON ' +
          '{doc_type, tax_year, payer:{name, ein_token}, fields:[{name, raw_text, normalized:{kind,value}, region:{page,x,y,w,h}, confidence}]}. '
          + 'Identifiers must be tokenized (tok_ein_*). If unreadable or an unknown type, return doc_type "UNREADABLE" — never guess.',
      },
      { role: 'user', content: `document ${input.doc_id} (${input.image_ref}):\n${input.ocr_text ?? ''}` },
    ];
  },
  /** Parse + tokenize echoed identifiers BEFORE validation or any downstream use. */
  parse: (raw) => sanitizeExtractionPii(JSON.parse(stripCodeFences(raw))),
  validateSchema: (candidate) => {
    const issues: SemanticIssue[] = [];
    if (!isRecord(candidate)) return { ok: false, issues: [{ message: 'expected object' }] };
    const docTypes: ExtractionDocType[] = [
      'W-2', '1099-INT', '1099-DIV', '1099-B', '1099-R', 'SSA-1099', 'CONSOLIDATED-1099',
      'K-1', '1095-A', '1098', 'PROPERTY-TAX-BILL', 'DONATION-RECEIPT', 'FOREIGN-REMITTANCE', 'UNREADABLE',
    ];
    const docType = docTypes.find((t) => t === candidate['doc_type']);
    if (!docType) issues.push({ field: 'doc_type', message: 'doc_type not in step-1 taxonomy' });
    if (candidate['tax_year'] !== null && typeof candidate['tax_year'] !== 'number') {
      issues.push({ field: 'tax_year', message: 'tax_year must be number|null' });
    }
    const payer = candidate['payer'];
    if (!isRecord(payer) || typeof payer['name'] !== 'string') {
      issues.push({ field: 'payer', message: 'payer{name} required' });
    }
    if (!Array.isArray(candidate['fields'])) {
      issues.push({ field: 'fields', message: 'fields[] required' });
    } else {
      for (const [i, f] of candidate['fields'].entries()) {
        if (!isRecord(f) || typeof f['name'] !== 'string' || typeof f['raw_text'] !== 'string') {
          issues.push({ field: `fields[${i}]`, message: 'field name/raw_text required' });
          continue;
        }
        const norm = f['normalized'];
        if (!isRecord(norm) || !['decimal', 'date', 'string'].includes(String(norm['kind']))) {
          issues.push({ field: `fields[${i}].normalized`, message: 'normalized{kind,value} required' });
        }
        const region = f['region'];
        if (!isRecord(region) || typeof region['page'] !== 'number') {
          issues.push({ field: `fields[${i}].region`, message: 'bounding region required (no-invention: every value cites a document region)' });
        }
        if (typeof f['confidence'] !== 'number' || f['confidence'] < 0 || f['confidence'] > 1) {
          issues.push({ field: `fields[${i}].confidence`, message: 'confidence in [0,1] required' });
        }
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: candidate as unknown as ExtractionOutput };
  },
  validateSemantic: (out) => {
    const issues: SemanticIssue[] = [];
    if (out.doc_type === 'UNREADABLE') return issues; // manual-entry path handles it
    const allowed = FIELD_SCHEMAS[out.doc_type];
    const decimals = new Map<string, Money>();
    for (const f of out.fields) {
      if (!allowed.includes(f.name)) {
        issues.push({ field: f.name, message: `field ${f.name} not in the ${out.doc_type} schema` });
      }
      if (f.normalized.kind === 'decimal') {
        try {
          decimals.set(f.name, Money.fromString(f.normalized.value));
        } catch {
          issues.push({ field: f.name, message: `normalized decimal "${f.normalized.value}" does not parse` });
        }
      }
    }
    if (out.payer.ein_token !== null && !/^tok_ein_[a-z0-9]+$/.test(out.payer.ein_token)) {
      issues.push({ field: 'payer.ein_token', message: 'EIN must be tokenized (tok_ein_*)' });
    }
    // W-2 checksum sanity: box 1 vs box 5 `(verify exact rule — PLACEHOLDER)`
    if (out.doc_type === 'W-2') {
      const box1 = decimals.get('box1_wages');
      const box5 = decimals.get('box5_medicare_wages');
      if (box1 && box5 && box1.gt(box5)) {
        issues.push({ field: 'box1_wages', message: 'checksum: W-2 box 1 exceeds box 5 (verify) — extraction suspect' });
      }
    }
    return issues;
  },
};

export interface ExtractionFlags {
  wrong_year: boolean;
  manual_entry: boolean;
}

export type ExtractionRun =
  | { status: 'ok'; output: ExtractionOutput; flags: ExtractionFlags; proposals: ProposalInput[] }
  | { status: 'manual_entry'; flags: ExtractionFlags }
  | { status: 'rejected'; issues: SemanticIssue[] };

/**
 * Wrapper: run the agent, derive flags, and shape review-pending proposals.
 * NOTE: no spine access here — proposals only become facts through the
 * ReviewPendingStore confirm path.
 */
export async function runExtraction(
  deps: AgentRunDeps,
  doc: DocImageStub,
  taxpayer_id: string,
): Promise<ExtractionRun> {
  const result = await runAgent(extractionAgent, doc, deps);
  if (result.status === 'rejected') return { status: 'rejected', issues: result.issues };
  const output = result.output;
  if (output.doc_type === 'UNREADABLE') {
    // Failure path: route to manual entry with the image alongside — never guess.
    return { status: 'manual_entry', flags: { wrong_year: false, manual_entry: true } };
  }
  const flags: ExtractionFlags = {
    wrong_year: output.tax_year !== null && output.tax_year !== doc.expected_tax_year,
    manual_entry: false,
  };
  const threshold = CONFIDENCE_THRESHOLDS[output.doc_type];
  const proposals: ProposalInput[] = [];
  const k1Id = output.doc_type === 'K-1' ? k1InstanceId(output.payer, doc.doc_id) : null;
  for (const f of output.fields) {
    const k1Map = k1Id !== null ? K1_CONCEPT_BY_FIELD[f.name] : undefined;
    const mapping = k1Map !== undefined && k1Id !== null
      ? { concept: `k1.${k1Id}.${k1Map.suffix}`, jurisdiction: k1Map.jurisdiction, critical: k1Map.critical }
      : CONCEPT_BY_FIELD[f.name];
    if (!mapping || f.normalized.kind !== 'decimal') continue; // unmapped/non-decimal fields propose nothing
    const belowThreshold = f.confidence < threshold;
    proposals.push({
      taxpayer_id,
      tax_year: doc.expected_tax_year,
      source_id: doc.doc_id,
      source_field: f.name,
      concept: mapping.concept,
      jurisdiction: mapping.jurisdiction,
      taxpayer_scope: 'primary',
      value: belowThreshold ? null : f.normalized.value, // empty-with-suggestion below threshold
      suggestion: belowThreshold ? f.normalized.value : null,
      confidence: f.confidence,
      critical: mapping.critical,
      region: f.region,
    });
  }
  return { status: 'ok', output, flags, proposals };
}
