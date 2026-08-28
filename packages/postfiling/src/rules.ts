/**
 * Workstream-I parameters + pre-approved factual templates (rule-data,
 * PLACEHOLDER-marked; loader refuses unmarked content — the standing
 * discipline). Explanation language is NEVER generated adaptively: these
 * fixed templates are the only source (I.4, UPL boundary).
 */
import { PLACEHOLDER } from '@taxfs/shared';

export type AmendmentReason = 'user_correction' | 'late_doc' | 'rule_patch' | 'notice_outcome';

export interface PostFilingRules {
  il_sync_window_days: number;
  dut_size_limit_bytes: number;
  agree_alert_template: string;
  il_sync_alert_template: string;
  amendment_templates: { template_id: string; reason: AmendmentReason; text: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER || typeof raw['value'] !== 'string') {
    throw new Error(`postfiling rules ${path}: figure with "${PLACEHOLDER}" marker required`);
  }
  return raw['value'];
}

const REASONS: AmendmentReason[] = ['user_correction', 'late_doc', 'rule_patch', 'notice_outcome'];

export function loadPostFilingRules(json: unknown): PostFilingRules {
  if (!isRecord(json) || !Array.isArray(json['amendment_templates'])) {
    throw new Error('postfiling rules: expected { amendment_templates: [...] }');
  }
  const templates = json['amendment_templates'].map((raw, i) => {
    if (!isRecord(raw) || raw['status'] !== PLACEHOLDER) {
      throw new Error(`postfiling amendment_templates[${i}]: missing "${PLACEHOLDER}" marker`);
    }
    const reason = REASONS.find((r) => r === raw['reason']);
    if (!reason) throw new Error(`postfiling amendment_templates[${i}]: unknown reason`);
    return { template_id: String(raw['template_id']), reason, text: String(raw['text']) };
  });
  for (const reason of REASONS) {
    if (!templates.some((t) => t.reason === reason)) {
      throw new Error(`postfiling rules: no template for reason "${reason}"`);
    }
  }
  return {
    il_sync_window_days: Number(figure(json['il_sync_window_days'], 'il_sync_window_days')),
    dut_size_limit_bytes: Number(figure(json['dut_size_limit_bytes'], 'dut_size_limit_bytes')),
    agree_alert_template: figure(json['agree_alert_template'], 'agree_alert_template'),
    il_sync_alert_template: figure(json['il_sync_alert_template'], 'il_sync_alert_template'),
    amendment_templates: templates,
  };
}

/**
 * Neutral-language discipline (I.4/I.7): generated responses present
 * records and rule-store citations; they never argue. These patterns are
 * linted in CI over templates, package source, and generated output.
 */
export const ADVOCACY_BANNED: { re: RegExp; reason: string }[] = [
  { re: /\b(?:we|I)\s+(?:contend|argue|maintain|insist|assert)\b/i, reason: 'argument framing' },
  { re: /\b(?:clearly|obviously|plainly|undeniably|indisputabl\w+)\b/i, reason: 'advocacy intensifier' },
  { re: /\bIRS\s+(?:is|was)\s+wrong\b/i, reason: 'position language — present the records instead' },
  { re: /\b(?:erroneous|baseless|meritless|frivolous)\b/i, reason: 'characterization of the other side' },
  { re: /\bentitled\s+to\b/i, reason: 'legal-conclusion language' },
  { re: /\bmust\s+(?:agree|concede|allow|accept)\b/i, reason: 'demand language' },
];

export function checkNeutralLanguage(text: string): { pattern: string; reason: string }[] {
  const hits: { pattern: string; reason: string }[] = [];
  for (const { re, reason } of ADVOCACY_BANNED) {
    if (re.test(text)) hits.push({ pattern: re.source, reason });
  }
  return hits;
}

export function fillTemplate(template: string, slots: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = slots[key];
    if (value === undefined) throw new Error(`template slot {${key}} not provided`);
    return value;
  });
  const violations = checkNeutralLanguage(filled);
  if (violations.length > 0) {
    throw new Error(`template output violates neutral-language rules: ${violations.map((v) => v.reason).join('; ')}`);
  }
  return filled;
}
