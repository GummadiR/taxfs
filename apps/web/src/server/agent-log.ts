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
