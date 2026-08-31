/**
 * Persistent agent-trace sink (§4 (h): auditability made visible). Every
 * harness call lands as an agent_traces row — hashes and verdicts only,
 * never prompt or output text (the S2 privacy discipline the in-memory log
 * already enforces). The /agents page reads it back.
 */
import type pg from 'pg';
import type { AgentCallLog, AgentLogSink } from '@taxfs/shared';

export class PgAgentLog implements AgentLogSink {
  private readonly pending: Promise<unknown>[] = [];
  constructor(
    private readonly client: pg.Client,
    private readonly ws: string,
  ) {}

  record(entry: AgentCallLog): void {
    this.pending.push(
      this.client.query(
        `insert into agent_traces (workspace_id, trace_id, agent, model, input_hash, output, validation)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          this.ws,
          `tr-${entry.agent_id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          entry.agent_id,
          `${entry.provider_id}:${entry.model}`,
          entry.input_hash,
          JSON.stringify({
            attempt: entry.attempt,
            output_hash: entry.output_hash,
            output_chars: entry.output_chars,
            issues: entry.issues,
          }),
          entry.validation_result === 'ok' ? 'accepted' : entry.attempt > 1 ? 'retried' : 'rejected',
        ],
      ),
    );
  }

  /** Callers flush before closing the connection. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}

export interface TraceRow {
  trace_id: string;
  agent: string;
  model: string;
  input_hash: string;
  validation: string;
  ts: string;
  detail: Record<string, unknown>;
}

export async function listTraces(client: pg.Client, ws: string, limit = 100): Promise<TraceRow[]> {
  const r = await client.query(
    `select trace_id, agent, model, input_hash, validation, ts, output as detail
       from agent_traces where workspace_id = $1 order by ts desc limit $2`,
    [ws, limit],
  );
  return r.rows.map((row) => ({ ...row, ts: (row.ts as Date).toISOString() }));
}

/**
 * One row per THING READ, not per model call.
 *
 * A re-scan reuses the document's own id and stored file, so its prompt is
 * byte-identical to the first read and lands on the same input hash. Grouping
 * on (agent, input hash) therefore collapses a document's reads into one row
 * whose size is how many times it has been read — and whose `answers` count
 * says whether those reads AGREED, since the sink stores an output hash (a
 * hash, never the text) beside every call.
 */
export interface TraceGroup {
  key: string;
  agent: string;
  model: string;
  input_hash: string;
  calls: number;
  first: string;
  last: string;
  /** Distinct answers across the group's calls. 1 ⇒ every read agreed. */
  answers: number;
  rejected: number;
  retried: number;
  issues: string[];
}

export function groupTraces(rows: TraceRow[]): TraceGroup[] {
  const byKey = new Map<string, TraceGroup>();
  const answersByKey = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.agent}|${r.input_hash}`;
    const detail = r.detail as { output_hash?: string; issues?: { message: string }[] };
    const answers = answersByKey.get(key) ?? new Set<string>();
    if (detail.output_hash) answers.add(detail.output_hash);
    answersByKey.set(key, answers);
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, {
        key,
        agent: r.agent,
        model: r.model,
        input_hash: r.input_hash,
        calls: 1,
        first: r.ts,
        last: r.ts,
        answers: answers.size,
        rejected: r.validation === 'rejected' ? 1 : 0,
        retried: r.validation === 'retried' ? 1 : 0,
        issues: (detail.issues ?? []).map((i) => i.message),
      });
      continue;
    }
    g.calls += 1;
    // Rows arrive newest first, so every later row is older than `first`.
    g.first = r.ts < g.first ? r.ts : g.first;
    g.last = r.ts > g.last ? r.ts : g.last;
    g.answers = answers.size;
    if (r.validation === 'rejected') g.rejected += 1;
    if (r.validation === 'retried') g.retried += 1;
    for (const i of detail.issues ?? []) if (!g.issues.includes(i.message)) g.issues.push(i.message);
  }
  return [...byKey.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}
