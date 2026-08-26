/**
 * D.3 — PDF (paper) target, placeholder-template stage.
 * Real output requires the official form PDFs (licensed/downloaded
 * artifacts — see README schema-procurement TODO). Until procured, the
 * renderer fills a PLACEHOLDER template whose field positions are marked
 * TODO, so the fill pipeline, assembly order, and lineage are exercised
 * now and real AcroForm templates drop in without engine change. Never
 * hand-edited post-generation.
 */
import { PLACEHOLDER } from '@taxfs/shared';
import type { FormDefinition, FormInstance } from './types';

export interface PdfTemplateConfig {
  release: string;
  /** Simple grid layout per form until real templates exist. */
  templates: Record<string, { page: number; start_x: number; start_y: number; line_height: number }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadPdfTemplates(json: unknown): PdfTemplateConfig {
  if (!isRecord(json) || typeof json['release'] !== 'string' || !isRecord(json['templates'])) {
    throw new Error('pdf templates: expected { release, templates }');
  }
  if (json['status'] !== PLACEHOLDER) {
    throw new Error(`pdf templates: missing "${PLACEHOLDER}" marker`);
  }
  const templates: PdfTemplateConfig['templates'] = {};
  for (const [formId, raw] of Object.entries(json['templates'])) {
    if (!isRecord(raw)) throw new Error(`pdf templates.${formId}: expected object`);
    templates[formId] = {
      page: Number(raw['page']),
      start_x: Number(raw['start_x']),
      start_y: Number(raw['start_y']),
      line_height: Number(raw['line_height']),
    };
  }
  return { release: json['release'], templates };
}

/** Deterministic placeholder rendering: one filled "page" per form. */
export function renderPdfPlaceholder(
  def: FormDefinition,
  instance: FormInstance,
  config: PdfTemplateConfig,
): string {
  const layout = config.templates[def.form_id];
  if (!layout) throw new Error(`pdf: no template layout for ${def.form_id}`);
  const out: string[] = [];
  out.push(`%TAXOS-PDF-PLACEHOLDER v1 — template ${def.pdf_template_ref}`);
  out.push(`%TODO: field positions unverified until the official ${def.form_id} template is procured`);
  out.push(`FORM ${def.form_id} rev ${def.revision} (${def.jurisdiction} ${def.tax_year}) — assembly order ${def.attachment_order}`);
  let row = 0;
  for (const line of def.lines) {
    const value = instance.values[line.line_id];
    if (value === undefined) continue;
    const y = layout.start_y - row * layout.line_height;
    out.push(
      `page ${layout.page} @(${layout.start_x},${y}) [POSITION-TODO] ${line.line_id} ${line.label}: ${value.toString()}`,
    );
    row = row + 1;
  }
  out.push('%signature-line: [POSITION-TODO] sign here — paper filing requires ink signature (verify)');
  return `${out.join('\n')}\n`;
}
