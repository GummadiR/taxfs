/**
 * ORIGIN: AHC (SCP repo) §4 — agent harness.
 * Clean-room TS implementation per spec E.0 (see provider.ts header for the
 * shared-import caveat).
 *
 * Agents are STATELESS TYPED WORKERS: definition = prompt builder + parser
 * + schema validator + semantic validator. The harness owns the loop:
 * call → parse → schema validation → semantic validation, retrying up to
 * the route's max_retries; outputs failing any step are rejected, never
 * passed through (E.0 typed-output contract). Every call is logged
 * (input hash, model, output, validation result) to a private sink — S2
 * discipline: internal, never IRS-facing.
 */
import type { LlmMessage } from './provider';
import { LlmClient, inputHash } from './llm-client';
import { TraceRecorder, compileTrace, type AgentTrace } from './trace-compiler';

export interface SemanticIssue {
  field?: string;
  message: string;
}

export type SchemaResult<TOut> = { ok: true; value: TOut } | { ok: false; issues: SemanticIssue[] };

export interface AgentDefinition<TIn, TOut> {
  id: string;
  buildMessages(input: TIn): LlmMessage[];
  /** Default JSON.parse when omitted. Throwing ⇒ parse rejection. */
  parse?(raw: string): unknown;
  validateSchema(candidate: unknown): SchemaResult<TOut>;
  /** Return [] when valid. Runs after schema validation. */
  validateSemantic?(value: TOut, input: TIn): SemanticIssue[];
}

export type ValidationVerdict = 'ok' | 'parse_rejected' | 'schema_rejected' | 'semantic_rejected';

/**
 * Private per-call log entry (S2 discipline: internal, never IRS-facing).
 * PRIVACY: carries HASHES and lengths only — never the prompt text and never
 * the raw model output, which for vision extraction would echo document
 * content. What is stored: input hash, model + provider version, validation
 * result, and issue messages.
 */
export interface AgentCallLog {
  agent_id: string;
  attempt: number;
  input_hash: string;
  model: string;
  provider_id: string;
  /** FNV-1a hash of the raw model output (correlation without content). */
  output_hash: string;
  /** Length of the raw model output in characters. */
  output_chars: number;
  validation_result: ValidationVerdict;
  issues: SemanticIssue[];
}

export interface AgentLogSink {
  record(entry: AgentCallLog): void;
}

export class InMemoryAgentLog implements AgentLogSink {
  readonly entries: AgentCallLog[] = [];
  record(entry: AgentCallLog): void {
    this.entries.push(entry);
  }
}

export type AgentRunResult<TOut> =
  | { status: 'ok'; output: TOut; attempts: number; trace: AgentTrace }
  | { status: 'rejected'; issues: SemanticIssue[]; attempts: number; trace: AgentTrace };

export interface AgentRunDeps {
  client: LlmClient;
  log: AgentLogSink;
}

export async function runAgent<TIn, TOut>(
  def: AgentDefinition<TIn, TOut>,
  input: TIn,
  deps: AgentRunDeps,
): Promise<AgentRunResult<TOut>> {
  const recorder = new TraceRecorder();
  const messages = def.buildMessages(input);
  recorder.add('prompt', 'messages', `${messages.length} message(s)`);
  const maxAttempts = deps.client.maxRetries(def.id) + 1;
  let lastIssues: SemanticIssue[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt = attempt + 1) {
    const call = await deps.client.call(def.id, messages);
    recorder.add('response', `attempt ${attempt}`, `${call.text.length} chars from ${call.model}`);

    const logBase = {
      agent_id: def.id,
      attempt,
      input_hash: call.input_hash,
      model: call.model,
      provider_id: call.provider_id,
      output_hash: inputHash(call.text),
      output_chars: call.text.length,
    };

    let candidate: unknown;
    try {
      candidate = def.parse ? def.parse(call.text) : JSON.parse(call.text);
    } catch (e) {
      lastIssues = [{ message: `output is not parseable: ${String(e)}` }];
      recorder.add('validation', `attempt ${attempt}`, 'parse_rejected');
      deps.log.record({ ...logBase, validation_result: 'parse_rejected', issues: lastIssues });
      continue;
    }

    const schema = def.validateSchema(candidate);
    if (!schema.ok) {
      lastIssues = schema.issues;
      recorder.add('validation', `attempt ${attempt}`, `schema_rejected: ${schema.issues.map((i) => i.message).join('; ')}`);
      deps.log.record({ ...logBase, validation_result: 'schema_rejected', issues: schema.issues });
      continue;
    }

    const semanticIssues = def.validateSemantic ? def.validateSemantic(schema.value, input) : [];
    if (semanticIssues.length > 0) {
      lastIssues = semanticIssues;
      recorder.add('validation', `attempt ${attempt}`, `semantic_rejected: ${semanticIssues.map((i) => i.message).join('; ')}`);
      deps.log.record({ ...logBase, validation_result: 'semantic_rejected', issues: semanticIssues });
      continue;
    }

    recorder.add('outcome', 'ok', `validated on attempt ${attempt}`);
    deps.log.record({ ...logBase, validation_result: 'ok', issues: [] });
    return { status: 'ok', output: schema.value, attempts: attempt, trace: compileTrace(def.id, recorder.steps) };
  }

  recorder.add('outcome', 'rejected', `all ${maxAttempts} attempt(s) failed validation`);
  return { status: 'rejected', issues: lastIssues, attempts: maxAttempts, trace: compileTrace(def.id, recorder.steps) };
}
