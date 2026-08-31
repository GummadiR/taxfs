/**
 * Identity fill — ISOMORPHIC (browser + node), the §5 client/server split.
 *
 * The server builds, validates and serves packages with the Step-1 identity
 * blocks EMPTY: names, SSNs, DOBs and addresses never reach the server, so
 * nothing server-side can store what it never receives (N8/G9). The BROWSER
 * applies these fields at download time from the operator's encrypted local
 * vault; the node-side tests apply them the same way to prove, byte-level,
 * that every value lands in its intended AcroForm field.
 *
 * Field names are the TaxOS-verified mappings (label↔widget geometry, never
 * guessed — the P80 rule), including:
 *  - P92: the federal SSN boxes are COMB fields with maxLength 9; pdf-lib
 *    refuses "123-45-6789" (11 chars) and a swallowed error printed a return
 *    with an EMPTY SSN box. Federal SSNs are stripped to digits; the IL
 *    fields have no maxLength and show the dashed form verbatim.
 *  - P81: the IL-1040 Step 1 asks for name, full SSN, DOB and address on its
 *    face — a blank Step 1 is not a filable return.
 */
import { PDFDocument } from 'pdf-lib';

export interface PersonIdentity {
  first_name?: string;
  last_name?: string;
  ssn?: string;
  /** ISO yyyy-mm-dd (what <input type="date"> gives). */
  dob?: string;
  /** 1040 line 12d / IL Step-4 boxes — drive the printed ticks only; the
   *  deduction math uses the non-identifying box COUNT from Get Started. */
  born_before_1961?: boolean;
  blind?: boolean;
}

export interface FilingIdentity {
  taxpayer: PersonIdentity;
  spouse?: PersonIdentity;
  address_line?: string;
  city?: string;
  state?: string;
  zip?: string;
}

const FORM_1040_IDENTITY: Record<string, string> = {
  tp_first: 'topmostSubform[0].Page1[0].f1_14[0]',
  tp_last: 'topmostSubform[0].Page1[0].f1_15[0]',
  tp_ssn: 'topmostSubform[0].Page1[0].f1_16[0]',
  sp_first: 'topmostSubform[0].Page1[0].f1_17[0]',
  sp_last: 'topmostSubform[0].Page1[0].f1_18[0]',
  sp_ssn: 'topmostSubform[0].Page1[0].f1_19[0]',
  address: 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_20[0]',
  city: 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_22[0]',
  state: 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_23[0]',
  zip: 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_24[0]',
};

const FORM_1040_AGE_BLIND: Record<'tp_65' | 'tp_blind' | 'sp_65' | 'sp_blind', string> = {
  tp_65: 'topmostSubform[0].Page2[0].c2_5[0]',
  tp_blind: 'topmostSubform[0].Page2[0].c2_6[0]',
  sp_65: 'topmostSubform[0].Page2[0].c2_7[0]',
  sp_blind: 'topmostSubform[0].Page2[0].c2_8[0]',
};

const IL_1040_IDENTITY: Record<string, string> = {
  tp_first: 'step1-A-firstnamemi',
  tp_last: 'step1-A-lastname',
  tp_ssn: 'step1-A-ssn',
  // NOTE the capital S — the taxpayer DOB field is named differently from
  // every one of its siblings on the official template.
  tp_dob: 'Step1-A-dob',
  sp_first: 'step1-A-spousefirstnamemi',
  sp_last: 'step1-A-spouselastname',
  sp_ssn: 'step1-A-spousessn',
  sp_dob: 'step1-A-spousedob',
  address: 'step1-A-mailingaddress',
  city: 'step1-A-city',
  state: 'step1-A-state',
  zip: 'step1-A-zip',
};

const IL_1040_AGE_BLIND = {
  tp_65: 'over_65_you',
  sp_65: 'over_65_spouse',
  tp_blind: 'blind_you',
  sp_blind: 'blind',
} as const;

type Form = ReturnType<PDFDocument['getForm']>;

function setIfPresent(form: Form, fieldName: string, value: string | undefined): void {
  if (!value) return;
  form.getTextField(fieldName).setText(value);
}

function checkIf(form: Form, fieldName: string, on: boolean | undefined): void {
  if (!on) return;
  form.getCheckBox(fieldName).check();
}

/** ISO yyyy-mm-dd → the mm/dd/yyyy the IL-1040 face wants; anything else
 *  passes through untouched rather than mangled. */
export function usDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** P92 — comb boxes take digits only; the form face draws the dashes. */
export function ssnDigits(ssn: string | undefined): string | undefined {
  const digits = ssn?.replace(/\D/g, '');
  return digits === '' ? undefined : digits;
}

export function applyIdentityFields(form: Form, id: FilingIdentity): void {
  const m = FORM_1040_IDENTITY;
  setIfPresent(form, m['tp_first']!, id.taxpayer.first_name);
  setIfPresent(form, m['tp_last']!, id.taxpayer.last_name);
  setIfPresent(form, m['tp_ssn']!, ssnDigits(id.taxpayer.ssn));
  if (id.spouse) {
    setIfPresent(form, m['sp_first']!, id.spouse.first_name);
    setIfPresent(form, m['sp_last']!, id.spouse.last_name);
    setIfPresent(form, m['sp_ssn']!, ssnDigits(id.spouse.ssn));
  }
  setIfPresent(form, m['address']!, id.address_line);
  setIfPresent(form, m['city']!, id.city);
  setIfPresent(form, m['state']!, id.state);
  setIfPresent(form, m['zip']!, id.zip);
  const cb = FORM_1040_AGE_BLIND;
  checkIf(form, cb.tp_65, id.taxpayer.born_before_1961);
  checkIf(form, cb.tp_blind, id.taxpayer.blind);
  if (id.spouse) {
    checkIf(form, cb.sp_65, id.spouse.born_before_1961);
    checkIf(form, cb.sp_blind, id.spouse.blind);
  }
}

export function applyIlIdentityFields(form: Form, id: FilingIdentity): void {
  const m = IL_1040_IDENTITY;
  setIfPresent(form, m['tp_first']!, id.taxpayer.first_name);
  setIfPresent(form, m['tp_last']!, id.taxpayer.last_name);
  setIfPresent(form, m['tp_ssn']!, id.taxpayer.ssn);
  setIfPresent(form, m['tp_dob']!, usDate(id.taxpayer.dob));
  if (id.spouse) {
    setIfPresent(form, m['sp_first']!, id.spouse.first_name);
    setIfPresent(form, m['sp_last']!, id.spouse.last_name);
    setIfPresent(form, m['sp_ssn']!, id.spouse.ssn);
    setIfPresent(form, m['sp_dob']!, usDate(id.spouse.dob));
  }
  setIfPresent(form, m['address']!, id.address_line);
  setIfPresent(form, m['city']!, id.city);
  setIfPresent(form, m['state']!, id.state);
  setIfPresent(form, m['zip']!, id.zip);
  const cb = IL_1040_AGE_BLIND;
  checkIf(form, cb.tp_65, id.taxpayer.born_before_1961);
  checkIf(form, cb.tp_blind, id.taxpayer.blind);
  if (id.spouse) {
    checkIf(form, cb.sp_65, id.spouse.born_before_1961);
    checkIf(form, cb.sp_blind, id.spouse.blind);
  }
}

/** Fill one downloaded artifact with identity, in whatever runtime called us.
 *  Unknown form ids return the bytes untouched (only the two main forms carry
 *  Step-1 identity blocks). Errors are LOUD: a value that cannot land in its
 *  field must never silently print an empty box (the P92 lesson — the old
 *  swallow-and-continue printed a return with no SSN). */
/**
 * What a filable Step 1 needs, in the operator's words. Returns [] when the
 * identity is complete.
 *
 * setIfPresent SKIPS an absent value by design — that is right for an
 * optional field and wrong for a required one, because the two are
 * indistinguishable at the point of filling. Without this check an EMPTY
 * identity fills nothing, throws nothing, and hands back a PDF whose Step 1
 * is blank while the UI reports success: exactly the swallowed-failure shape
 * of P92, one layer up. The IL-1040 asks for name, full SSN, DOB and address
 * on its face (P81), so a blank Step 1 is not a filable return.
 *
 * `joint` adds the spouse's fields — on a joint return an unnamed spouse is
 * as unfilable as an unnamed taxpayer.
 */
export function missingIdentityFields(
  identity: FilingIdentity,
  formId: '1040' | 'IL1040' | string,
  joint = false,
): string[] {
  const missing: string[] = [];
  const blank = (v: string | undefined): boolean => (v ?? '').trim() === '';
  const person = (p: PersonIdentity | undefined, who: string): void => {
    if (blank(p?.first_name)) missing.push(`${who} first name`);
    if (blank(p?.last_name)) missing.push(`${who} last name`);
    // A partial SSN never reaches a form: 9 digits or it is missing.
    if ((ssnDigits(p?.ssn) ?? '').length !== 9) missing.push(`${who} SSN (9 digits)`);
    // Only the IL-1040 face carries a date of birth.
    if (formId === 'IL1040' && blank(p?.dob)) missing.push(`${who} date of birth`);
  };
  person(identity.taxpayer, 'Your');
  if (joint) person(identity.spouse, "Spouse's");
  if (blank(identity.address_line)) missing.push('Street address');
  if (blank(identity.city)) missing.push('City');
  if (blank(identity.state)) missing.push('State');
  if (blank(identity.zip)) missing.push('ZIP');
  return missing;
}

/**
 * Does this form carry a Step-1 identity block at all?
 *
 * A caller that offers an "identity filled" download MUST check this first.
 * fillIdentity passes a non-identity form through untouched (right for
 * Schedule B), so without this the caller would report a filled identity over
 * a PDF it never wrote to — the P92 swallowed-failure shape, one layer up.
 */
export function hasIdentityLayout(formId: string): formId is '1040' | 'IL1040' {
  return formId === '1040' || formId === 'IL1040';
}

/** The refusal, in one place, so the UI and the fill can never disagree. */
export function incompleteIdentityMessage(missing: string[]): string {
  return (
    `nothing was filled in — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. ` +
    'If you saved your details earlier, enter your passphrase and press Load first; ' +
    'otherwise type them above. (They never leave this browser.)'
  );
}

/**
 * Fill the Step-1 identity block. REFUSES an incomplete identity rather than
 * returning a PDF with silently empty boxes — see missingIdentityFields.
 * Pass `{ allowIncomplete: true }` only for the deliberate identity-blank
 * download, where empty boxes are the point.
 */
export async function fillIdentity(
  pdfBytes: Uint8Array,
  formId: '1040' | 'IL1040' | string,
  identity: FilingIdentity,
  opts: { joint?: boolean; allowIncomplete?: boolean } = {},
): Promise<Uint8Array> {
  // A form with no identity block (Schedule B, say) passes through untouched —
  // that is correct, not a failure. What must never happen is a CALLER telling
  // the operator "identity filled" over such a pass-through; hasIdentityLayout
  // exists so the caller can refuse before promising anything.
  if (!hasIdentityLayout(formId)) return pdfBytes;
  if (!opts.allowIncomplete) {
    const missing = missingIdentityFields(identity, formId, opts.joint ?? false);
    if (missing.length > 0) throw new Error(incompleteIdentityMessage(missing));
  }
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  if (formId === '1040') applyIdentityFields(doc.getForm(), identity);
  else applyIlIdentityFields(doc.getForm(), identity);
  return doc.save();
}

export function identityFieldName(slot: string): string {
  const name = FORM_1040_IDENTITY[slot];
  if (!name) throw new Error(`unknown 1040 identity slot ${slot}`);
  return name;
}

export function ilIdentityFieldName(slot: string): string {
  const name = IL_1040_IDENTITY[slot];
  if (!name) throw new Error(`unknown IL-1040 identity slot ${slot}`);
  return name;
}

export function ageBlindFieldName(slot: keyof typeof FORM_1040_AGE_BLIND): string {
  return FORM_1040_AGE_BLIND[slot];
}
