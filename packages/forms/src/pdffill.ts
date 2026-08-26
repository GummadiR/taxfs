/**
 * P11.1 — real print-and-mail channel: fill the OFFICIAL form PDFs
 * (procurement artifacts dropped into templates/pdf/<year>/<jur>/, never
 * committed as hand-drawn substitutes) using a field-map release that binds
 * each form line_id to the PDF's AcroForm field name.
 *
 * Discipline, same as everywhere else:
 * - The fill layer does NO math — it prints kernel-emitted line values.
 * - A line with a value but no field mapping is a DEFECT (a mailed form
 *   with a silently missing amount is a wrong filing), never skipped.
 * - A mapped field missing from the PDF is a hard error at fill time.
 * - Identity fields (name, SSN, address) are deliberately NOT filled and
 *   NOT mapped — TaxOS never holds them. The output stays an editable
 *   AcroForm so the filer types them in before printing and signing.
 */
import { PDFDocument, PDFCheckBox, PDFName, PDFTextField } from 'pdf-lib';
import { PLACEHOLDER } from '@taxfs/shared';
import type { FormDefinition, FormInstance } from './types';

export interface FormFieldMap {
  /** Repo-relative path of the official template this map was verified against. */
  template_path: string;
  /** line_id → AcroForm field name (text fields). */
  fields: Record<string, string>;
  /** Optional checkbox to tick when the form applies (e.g. Sch 2 box). */
  check_on_present?: Record<string, string>;
  /** P80 — filing_status → the control to tick. Two shapes, because the two
   *  governments build the control differently:
   *    "fieldName"              federal: five separate checkboxes (1040)
   *    "fieldName|exportValue"  Illinois: ONE field, five named states
   *  A return with no status ticked is not a valid return in either. */
  filing_status_boxes?: Record<string, string>;
}

export interface FieldMapRelease {
  release: string;
  forms: Record<string, FormFieldMap>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Loader refuses unmarked releases — a "real-looking" map that nobody
 *  verified against the actual PDF cannot silently enter the channel. */
export function loadFieldMaps(json: unknown): FieldMapRelease {
  if (!isRecord(json) || typeof json['release'] !== 'string' || !isRecord(json['forms'])) {
    throw new Error('pdf field maps: expected { release, status, forms }');
  }
  if (json['status'] !== PLACEHOLDER) {
    throw new Error(`pdf field maps: missing "${PLACEHOLDER}" marker`);
  }
  const forms: Record<string, FormFieldMap> = {};
  for (const [formId, raw] of Object.entries(json['forms'])) {
    if (!isRecord(raw) || typeof raw['template_path'] !== 'string' || !isRecord(raw['fields'])) {
      throw new Error(`pdf field maps.${formId}: expected { template_path, fields }`);
    }
    const fields: Record<string, string> = {};
    for (const [lineId, name] of Object.entries(raw['fields'])) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`pdf field maps.${formId}.fields.${lineId}: field name must be a non-empty string`);
      }
      fields[lineId] = name;
    }
    const entry: FormFieldMap = { template_path: raw['template_path'], fields };
    if (isRecord(raw['check_on_present'])) {
      const checks: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw['check_on_present'])) checks[k] = String(v);
      entry.check_on_present = checks;
    }
    if (isRecord(raw['filing_status_boxes'])) {
      const boxes: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw['filing_status_boxes'])) boxes[k] = String(v);
      entry.filing_status_boxes = boxes;
    }
    forms[formId] = entry;
  }
  return { release: json['release'], forms };
}

/** IRS paper convention: whole dollars, no thousands separators; negative
 *  amounts print in parentheses `(verify per-form loss-line convention)`. */
export function formatAmountForPaper(value: string): string {
  return value.startsWith('-') ? `(${value.slice(1)})` : value;
}

export interface PdfFillResult {
  /** Filled PDF bytes (AcroForm left editable for identity fields + review). */
  bytes: Uint8Array;
  /** Lines that HAD a value but no mapping — must surface as mapping defects. */
  unmapped_line_ids: string[];
  /** P81 — lines whose value does not FIT its box (the template caps some
   *  fields, e.g. IL-1040 line 10a is 4 characters). A too-long amount used to
   *  throw and kill the whole package build; it is a mapping defect like any
   *  other, and must block a clean lock without losing the rest of the return. */
  overflow_line_ids: { line_id: string; field: string; value: string; max_length: number }[];
  /** Fields actually written, for the fill report. */
  filled: { line_id: string; field: string; value: string }[];
}

export async function fillPdfForm(
  templateBytes: Uint8Array,
  def: FormDefinition,
  instance: FormInstance,
  map: FormFieldMap,
  filingStatus?: string,
): Promise<PdfFillResult> {
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const unmapped: string[] = [];
  const overflow: PdfFillResult['overflow_line_ids'] = [];
  const filled: PdfFillResult['filled'] = [];
  for (const line of def.lines) {
    const value = instance.values[line.line_id];
    if (value === undefined) continue;
    const fieldName = map.fields[line.line_id];
    if (fieldName === undefined) {
      unmapped.push(line.line_id);
      continue;
    }
    const field = form.getField(fieldName); // throws with the field name if absent
    if (!(field instanceof PDFTextField)) {
      throw new Error(`pdf fill ${def.form_id}.${line.line_id}: field "${fieldName}" is not a text field`);
    }
    const text = formatAmountForPaper(value.toString());
    const max = field.getMaxLength();
    if (max !== undefined && text.length > max) {
      overflow.push({ line_id: line.line_id, field: fieldName, value: text, max_length: max });
      continue;
    }
    field.setText(text);
    filled.push({ line_id: line.line_id, field: fieldName, value: text });
  }
  for (const [, boxName] of Object.entries(map.check_on_present ?? {})) {
    const box = form.getField(boxName);
    if (box instanceof PDFCheckBox) box.check();
  }
  // P80 — tick the filing-status box. A 1040 with no status ticked is not a
  // valid return, and every package built before this shipped without one.
  if (filingStatus && map.filing_status_boxes) {
    const boxName = map.filing_status_boxes[filingStatus];
    if (boxName === undefined) {
      throw new Error(`pdf fill ${def.form_id}: no filing-status checkbox mapped for "${filingStatus}"`);
    }
    const sep = boxName.indexOf('|');
    if (sep === -1) {
      const box = form.getField(boxName);
      if (!(box instanceof PDFCheckBox)) {
        throw new Error(`pdf fill ${def.form_id}: filing-status field "${boxName}" is not a checkbox`);
      }
      box.check();
    } else {
      // One field, several widgets, each with its own on-state: set the field
      // value AND the matching widget's appearance state, or the box shows
      // unticked even though the value is stored.
      const fieldName = boxName.slice(0, sep);
      const state = PDFName.of(boxName.slice(sep + 1));
      const box = form.getField(fieldName);
      if (!(box instanceof PDFCheckBox)) {
        throw new Error(`pdf fill ${def.form_id}: filing-status field "${fieldName}" is not a checkbox`);
      }
      let matched = false;
      for (const widget of box.acroField.getWidgets()) {
        const on = widget.getOnValue();
        if (on !== undefined && on.asString() === state.asString()) {
          widget.setAppearanceState(state);
          matched = true;
        } else {
          widget.setAppearanceState(PDFName.of('Off'));
        }
      }
      if (!matched) {
        throw new Error(`pdf fill ${def.form_id}: filing-status "${filingStatus}" has no widget state "${state.asString()}" on field "${fieldName}"`);
      }
      box.acroField.dict.set(PDFName.of('V'), state);
    }
  }
  // NOT flattened: identity fields stay typeable, amounts stay inspectable.
  const bytes = await doc.save();
  return { bytes, unmapped_line_ids: unmapped, overflow_line_ids: overflow, filled };
}

/** Dump every AcroForm field of a template — the mapping workbench used by
 *  scripts/dump-pdf-fields.ts when official PDFs land. */
export async function listPdfFields(
  templateBytes: Uint8Array,
): Promise<{ name: string; type: string }[]> {
  const doc = await PDFDocument.load(templateBytes);
  return doc.getForm().getFields().map((f) => ({ name: f.getName(), type: f.constructor.name }));
}
