/**
 * Complexity routing (Blueprint §6): simple single-form documents ride the
 * small model; K-1s, consolidated statements and other hard reads ride the
 * frontier model. Routing is by DOCUMENT TYPE, resolved before the call —
 * the router itself stays the dumb agent_id→model table it already is.
 */
import type { ExtractionDocType } from './extraction';

export const EXTRACTION_SIMPLE_AGENT_ID = 'extraction_simple';
export const EXTRACTION_FRONTIER_AGENT_ID = 'extraction';

const SIMPLE_DOC_TYPES: readonly ExtractionDocType[] = [
  'W-2', '1099-INT', '1099-DIV', '1099-R', 'SSA-1099', '1098',
  'PROPERTY-TAX-BILL', 'DONATION-RECEIPT',
];

export function extractionAgentIdFor(docType: ExtractionDocType): string {
  return SIMPLE_DOC_TYPES.includes(docType) ? EXTRACTION_SIMPLE_AGENT_ID : EXTRACTION_FRONTIER_AGENT_ID;
}

/** Default model tiers (overridable at deps construction; env decides in the
 *  app). Latest generally-available models per tier. */
export const DEFAULT_EXTRACTION_MODELS = {
  [EXTRACTION_SIMPLE_AGENT_ID]: 'claude-haiku-4-5-20251001',
  [EXTRACTION_FRONTIER_AGENT_ID]: 'claude-fable-5',
} as const;
