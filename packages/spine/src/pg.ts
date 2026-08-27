/**
 * Postgres adapter for the spine — v2, on the Blueprint §4 schema.
 *
 * Ported from the TaxOS adapter (its reconnect handling, no-op idempotency,
 * cascade semantics and lineage walk are hard-won), adapted to the TaxFS
 * schema and tenancy model:
 *
 * - Every table is workspace-scoped with a composite PK, RLS ENABLED and
 *   FORCED; the adapter connects as a restricted role (never the table
 *   owner) and pins the caller's auth identity via the same JWT-claim GUCs
 *   Supabase's auth.uid() reads. A connection whose role could bypass RLS
 *   is REFUSED at connect (the TaxOS live lesson: a table-owner connection
 *   silently disabled every policy and only the isolation test noticed).
 * - One adapter instance = one (auth user, workspace). Every statement
 *   carries the workspace_id explicitly: with composite PKs the same
 *   fact_id may legally exist in two workspaces, so id-only lookups would
 *   be a cross-workspace defect (the P36/P38 class) even under RLS.
 * - The TS contract keeps `taxpayer_id` (kernel/gates are ported verbatim);
 *   the schema column is `workspace_id`. The mapping lives HERE and only
 *   here, at the SQL boundary.
 * - Findings persist as (critic_id, severity, payload jsonb) per §4; the
 *   payload carries the full Finding shape verbatim.
 * - Calculations persist the §3.2 tie-out decomposition (terms, clamp_zero)
 *   so stored lineage carries exactly what the kernel emitted.
 * - No-op writes are detected BEFORE any DML (identical putSourceFact or a
 *   clean recompute produces zero audit rows — same as the reference).
 * - Money crosses the wire as decimal strings into numeric(16,2).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import {
  Money,
  type AuditLogEntry,
  type Calculation,
  type FactStatus,
  type Finding,
  type GateId,
  type GateRun,
  type Jurisdiction,
  type SourceDoc,
  type SourceType,
  type TaxFact,
  type TaxpayerScope,
} from '@taxfs/shared';
import type {
  RegisterKind,
  RegisterSnapshot,
  ComputationResult,
  FactQuery,
  GateRunInput,
  LineageNode,
  PutSourceFactInput,
  SpineBackend,
  StalenessImpact,
} from './contracts';

interface FactRow {
  fact_id: string;
  taxpayer_id: string;
  concept: string;
  tax_year: number;
  jurisdictions: Jurisdiction[];
  taxpayer_scope: string;
  value: string;
  unit: string;
  status: FactStatus;
  confidence: string | number;
  derivation_calc_id: string | null;
  prov: { source_id: string; source_field: string }[];
}

const FACT_SELECT = `
  select f.fact_id, f.workspace_id as taxpayer_id, f.concept, f.tax_year, f.jurisdictions,
         f.taxpayer_scope, f.value::text as value, f.unit, f.status, f.confidence,
         f.derivation_calc_id,
         coalesce(
           json_agg(json_build_object('source_id', p.source_id, 'source_field', p.source_field))
             filter (where p.fact_id is not null),
           '[]'
         ) as prov
    from tax_facts f
    left join fact_provenance p
           on p.workspace_id = f.workspace_id and p.fact_id = f.fact_id
`;

const FACT_GROUP = 'group by f.workspace_id, f.fact_id';

function rowToFact(r: FactRow): TaxFact {
  const fact: TaxFact = {
    fact_id: r.fact_id,
    taxpayer_id: r.taxpayer_id,
    concept: r.concept,
    tax_year: r.tax_year,
    jurisdiction: r.jurisdictions,
    taxpayer_scope: r.taxpayer_scope as TaxpayerScope,
    value: Money.fromString(r.value),
    unit: 'USD',
    status: r.status,
    confidence: Number(r.confidence),
  };
  if (r.derivation_calc_id !== null) {
    fact.derivation = r.derivation_calc_id;
  } else {
    fact.provenance = r.prov;
  }
  return fact;
}

function rowToCalc(c: Record<string, unknown>, inputs: string[]): Calculation {
  const calc: Calculation = {
    calc_id: c['calc_id'] as string,
    taxpayer_id: c['taxpayer_id'] as string,
    concept: c['concept'] as string,
    output_fact_id: c['output_fact_id'] as string,
    rule_version: c['rule_version'] as string,
    inputs,
    formula_ref: c['formula_ref'] as string,
    steps: c['steps'] as string[],
    value: Money.fromString(c['value'] as string),
  };
  if (c['terms'] != null) calc.terms = c['terms'] as Calculation['terms'];
  if (c['clamp_zero'] === true) calc.clamp_zero = true;
  return calc;
}

export interface PgSpineIdentity {
  /** The authenticated user (Supabase JWT sub). */
  authUserId: string;
  /** The workspace this adapter instance acts within. */
  workspaceId: string;
}

export class PgSpine implements SpineBackend {
  private client: pg.Client;
  private dead = false;
  private inTx = false;
  private readonly ws: string;

  /** Statements are serialized (see the TaxOS note this is ported from): a
   *  transaction span holds the lock begin..commit so no other caller's
   *  statement can join an open transaction. */
  private readonly lockHeld = new AsyncLocalStorage<true>();
  private chain: Promise<unknown> = Promise.resolve();

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockHeld.getStore()) return fn();
    const run = this.chain.then(() => this.lockHeld.run(true, fn));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.locked(async () => {
      await this.exec('begin');
      try {
        const out = await fn();
        await this.exec('commit');
        return out;
      } catch (e) {
        await this.exec('rollback');
        throw e;
      }
    });
  }

  private constructor(
    client: pg.Client,
    private readonly config: pg.ClientConfig,
    private readonly identity: PgSpineIdentity,
  ) {
    this.client = client;
    this.ws = identity.workspaceId;
    this.watch(client);
  }

  static async create(config: pg.ClientConfig, identity: PgSpineIdentity): Promise<PgSpine> {
    return new PgSpine(await PgSpine.connect(config, identity.authUserId), config, identity);
  }

  private static async connect(config: pg.ClientConfig, authUserId: string): Promise<pg.Client> {
    const client = new pg.Client(config);
    await client.connect();
    // Refuse a connection RLS would not bind (owner/superuser/bypassrls):
    // the walls must apply to the app, always.
    const guard = await client.query(
      `select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    if (guard.rows[0]?.bypass === true) {
      await client.end();
      throw new Error('PgSpine: refusing connection — current role would bypass row-level security');
    }
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: authUserId, role: 'authenticated' }),
    ]);
    await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [authUserId]);
    return client;
  }

  private watch(client: pg.Client): void {
    client.on('error', () => {
      this.dead = true;
      this.inTx = false;
    });
  }

  private static isConnectionError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    return (
      code === 'ECONNRESET' || code === 'EPIPE' || code === '57P01' ||
      /connection (terminated|error)|not queryable|Client has encountered a connection error/i.test(msg)
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches pg.Client.query's own default row typing
  private async exec<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.locked(() => this.execOnConnection<R>(text, values));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches pg.Client.query's own default row typing
  private async execOnConnection<R extends pg.QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    if (this.dead && !this.inTx) await this.reconnect();
    const lowered = text.trim().toLowerCase();
    try {
      const res = await this.client.query<R>(text, values);
      if (lowered === 'begin') this.inTx = true;
      if (lowered === 'commit' || lowered === 'rollback') this.inTx = false;
      return res;
    } catch (e) {
      if (!PgSpine.isConnectionError(e)) throw e;
      const wasInTx = this.inTx;
      this.inTx = false;
      await this.reconnect();
      if (wasInTx && lowered !== 'begin') {
        throw new Error(
          'PgSpine: connection lost mid-transaction — the server rolled it back; the connection has been restored, retry the operation',
        );
      }
      const res = await this.client.query<R>(text, values);
      if (lowered === 'begin') this.inTx = true;
      return res;
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      // already gone
    }
    this.client = await PgSpine.connect(this.config, this.identity.authUserId);
    this.watch(this.client);
    this.dead = false;
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  // ---------- SourceStore ----------

  async registerSource(doc: Omit<SourceDoc, 'review_status'>): Promise<SourceDoc> {
    try {
      await this.exec(
        `insert into sources (workspace_id, source_id, type, tax_year, fields, ocr_confidence, raw_ref)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [doc.taxpayer_id, doc.source_id, doc.type, doc.tax_year, JSON.stringify(doc.fields), doc.ocr_confidence, doc.raw_ref],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new Error(`source ${doc.source_id} already registered (sources are immutable)`);
      }
      throw e;
    }
    return { ...doc, review_status: 'pending' };
  }

  async confirmSource(source_id: string): Promise<void> {
    const res = await this.exec(
      `update sources set review_status = 'confirmed'
        where workspace_id = $1 and source_id = $2 and review_status <> 'confirmed'`,
      [this.ws, source_id],
    );
    if (res.rowCount === 0) {
      const exists = await this.exec(`select 1 from sources where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
      if (exists.rowCount === 0) throw new Error(`source ${source_id} not found`);
    }
  }

  async amendSourceField(source_id: string, field: string, value: string): Promise<void> {
    const res = await this.exec(
      `update sources
          set fields = jsonb_set(fields, array[$3::text], to_jsonb($4::text))
        where workspace_id = $1 and source_id = $2 and fields ->> $3 is distinct from $4`,
      [this.ws, source_id, field, value],
    );
    if (res.rowCount === 0) {
      const exists = await this.exec(`select 1 from sources where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
      if (exists.rowCount === 0) throw new Error(`source ${source_id} not found`);
    }
  }

  async deleteSource(source_id: string, opts?: { cascade?: boolean }): Promise<{ deleted_fact_ids: string[] }> {
    return this.tx(async () => {
      const srcRes = await this.exec<{ tax_year: number }>(
        `select tax_year from sources where workspace_id = $1 and source_id = $2`,
        [this.ws, source_id],
      );
      if (srcRes.rowCount === 0) throw new Error(`source ${source_id} not found`);
      const factRes = await this.exec<{ fact_id: string }>(
        `select distinct f.fact_id
           from tax_facts f
           join fact_provenance p on p.workspace_id = f.workspace_id and p.fact_id = f.fact_id
          where f.workspace_id = $1 and p.source_id = $2 and f.derivation_calc_id is null`,
        [this.ws, source_id],
      );
      const factIds = factRes.rows.map((r) => r.fact_id);

      if (opts?.cascade) {
        const { tax_year } = srcRes.rows[0]!;
        const derivedRes = await this.exec<{ fact_id: string }>(
          `select fact_id from tax_facts
            where workspace_id = $1 and tax_year = $2 and derivation_calc_id is not null`,
          [this.ws, tax_year],
        );
        const derivedIds = derivedRes.rows.map((r) => r.fact_id);
        await this.exec(`delete from fact_dependencies where workspace_id = $1`, [this.ws]);
        // derivation_calc_id has no FK in the §4 schema, so calc/fact
        // deletion order needs no deferral — clear the pointer first anyway
        // so a partial failure can never leave a dangling reference.
        await this.exec(`update tax_facts set derivation_calc_id = null where workspace_id = $1 and derivation_calc_id is not null`, [this.ws]);
        await this.exec(`delete from calculations where workspace_id = $1`, [this.ws]);
        if (derivedIds.length > 0) {
          await this.exec(`delete from tax_facts where workspace_id = $1 and fact_id = any($2::text[])`, [this.ws, derivedIds]);
        }
        await this.exec(`delete from fact_provenance where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
        if (factIds.length > 0) {
          await this.exec(`delete from tax_facts where workspace_id = $1 and fact_id = any($2::text[])`, [this.ws, factIds]);
        }
        await this.exec(`delete from sources where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
        return { deleted_fact_ids: [...new Set([...factIds, ...derivedIds])] };
      }

      if (factIds.length > 0) {
        const consumed = await this.exec(
          `select 1 from fact_dependencies where workspace_id = $1 and input_fact_id = any($2::text[]) limit 1`,
          [this.ws, factIds],
        );
        if ((consumed.rowCount ?? 0) > 0) {
          throw new Error(
            `document ${source_id} has values already used in computed results — re-open and re-run before removing it`,
          );
        }
      }
      await this.exec(`delete from fact_provenance where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
      if (factIds.length > 0) {
        await this.exec(`delete from tax_facts where workspace_id = $1 and fact_id = any($2::text[])`, [this.ws, factIds]);
      }
      await this.exec(`delete from sources where workspace_id = $1 and source_id = $2`, [this.ws, source_id]);
      return { deleted_fact_ids: factIds };
    });
  }

  async getSources(taxpayer_id: string, tax_year: number): Promise<SourceDoc[]> {
    const res = await this.exec(
      `select source_id, workspace_id as taxpayer_id, type, tax_year, fields, ocr_confidence, raw_ref, review_status
         from sources where workspace_id = $1 and tax_year = $2 order by source_id`,
      [taxpayer_id, tax_year],
    );
    return res.rows.map((r) => ({
      source_id: r.source_id,
      taxpayer_id: r.taxpayer_id,
      type: r.type as SourceType,
      tax_year: r.tax_year,
      fields: r.fields as Record<string, string>,
      ocr_confidence: Number(r.ocr_confidence),
      raw_ref: r.raw_ref,
      review_status: r.review_status,
    }));
  }

  // ---------- RegisterStore ----------

  private static registerRow(r: Record<string, unknown>): RegisterSnapshot {
    return {
      register_id: r['register_id'] as string,
      taxpayer_id: r['taxpayer_id'] as string,
      scope_ref: r['scope_ref'] as string,
      kind: r['kind'] as RegisterKind,
      tax_year: r['tax_year'] as number,
      opening: (r['opening'] ?? {}) as Record<string, string>,
      activity: (r['activity'] ?? {}) as Record<string, string>,
      closing: (r['closing'] ?? null) as Record<string, string> | null,
      status: r['status'] as 'open' | 'closed',
      closed_by_package_id: (r['closed_by_package_id'] ?? null) as string | null,
      opening_source_ref: (r['opening_source_ref'] ?? null) as string | null,
    };
  }

  private static readonly REGISTER_SELECT =
    `select register_id, workspace_id as taxpayer_id, scope_ref, kind, tax_year,
            opening, activity, closing, status, closed_by_package_id, opening_source_ref
       from registers`;

  async upsertRegister(
    reg: Omit<RegisterSnapshot, 'status' | 'closing' | 'closed_by_package_id'>,
  ): Promise<RegisterSnapshot> {
    const res = await this.exec(
      `insert into registers (workspace_id, register_id, scope_ref, kind, tax_year,
                              opening, activity, opening_source_ref)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       on conflict (workspace_id, register_id) do update
         set opening = excluded.opening,
             activity = excluded.activity,
             opening_source_ref = excluded.opening_source_ref
         where registers.kind = excluded.kind
           and registers.tax_year = excluded.tax_year
       returning register_id, workspace_id as taxpayer_id, scope_ref, kind, tax_year,
                 opening, activity, closing, status, closed_by_package_id, opening_source_ref`,
      [
        reg.taxpayer_id, reg.register_id, reg.scope_ref, reg.kind, reg.tax_year,
        JSON.stringify(reg.opening), JSON.stringify(reg.activity), reg.opening_source_ref,
      ],
    );
    if (res.rowCount === 0) {
      throw new Error(`register ${reg.register_id}: taxpayer/kind/tax_year are immutable`);
    }
    return PgSpine.registerRow(res.rows[0]);
  }

  async getRegisters(taxpayer_id: string, tax_year: number, kind?: RegisterKind): Promise<RegisterSnapshot[]> {
    const params: unknown[] = [taxpayer_id, tax_year];
    let where = 'workspace_id = $1 and tax_year = $2';
    if (kind !== undefined) {
      params.push(kind);
      where += ' and kind = $3';
    }
    const res = await this.exec(`${PgSpine.REGISTER_SELECT} where ${where} order by register_id`, params);
    return res.rows.map((r) => PgSpine.registerRow(r));
  }

  async closeRegister(
    register_id: string,
    closing: Record<string, string>,
    closed_by_package_id: string,
  ): Promise<RegisterSnapshot> {
    return this.tx(async () => {
      const cur = await this.exec(
        `${PgSpine.REGISTER_SELECT} where workspace_id = $1 and register_id = $2 for update`,
        [this.ws, register_id],
      );
      if (cur.rowCount === 0) throw new Error(`register ${register_id} not found`);
      const row = PgSpine.registerRow(cur.rows[0]);
      if (row.status === 'closed') throw new Error(`register ${register_id} already closed`);
      const closedRes = await this.exec(
        `update registers
            set closing = $3::jsonb, status = 'closed', closed_by_package_id = $4
          where workspace_id = $1 and register_id = $2
          returning register_id, workspace_id as taxpayer_id, scope_ref, kind, tax_year,
                    opening, activity, closing, status, closed_by_package_id, opening_source_ref`,
        [this.ws, register_id, JSON.stringify(closing), closed_by_package_id],
      );
      const nextId = `${register_id.replace(/:y\d+$/, '')}:y${row.tax_year + 1}`;
      await this.exec(
        `insert into registers (workspace_id, register_id, scope_ref, kind, tax_year,
                                opening, activity, opening_source_ref)
         values ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7)
         on conflict (workspace_id, register_id) do nothing`,
        [this.ws, nextId, row.scope_ref, row.kind, row.tax_year + 1,
         JSON.stringify(closing), `register://${register_id}`],
      );
      return PgSpine.registerRow(closedRes.rows[0]);
    });
  }

  // ---------- SpineContracts ----------

  async getFacts(query: FactQuery): Promise<TaxFact[]> {
    const where: string[] = ['f.workspace_id = $1', 'f.tax_year = $2'];
    const params: unknown[] = [query.taxpayer_id, query.tax_year];
    if (query.concepts) {
      params.push(query.concepts);
      where.push(`f.concept = any($${params.length})`);
    }
    if (query.jurisdiction) {
      params.push(query.jurisdiction);
      where.push(`$${params.length} = any(f.jurisdictions)`);
    }
    if (query.scope) {
      params.push(query.scope);
      where.push(`f.taxpayer_scope = $${params.length}`);
    }
    const res = await this.exec(
      `${FACT_SELECT} where ${where.join(' and ')} ${FACT_GROUP} order by f.fact_id`,
      params,
    );
    return (res.rows as FactRow[]).map(rowToFact);
  }

  private async factById(fact_id: string): Promise<TaxFact | undefined> {
    const res = await this.exec(
      `${FACT_SELECT} where f.workspace_id = $1 and f.fact_id = $2 ${FACT_GROUP}`,
      [this.ws, fact_id],
    );
    const row = (res.rows as FactRow[])[0];
    return row ? rowToFact(row) : undefined;
  }

  async putSourceFact(input: PutSourceFactInput): Promise<TaxFact> {
    if (input.provenance.length === 0) {
      throw new Error(`putSourceFact ${input.fact_id}: sourced facts require provenance`);
    }
    const existing = await this.factById(input.fact_id);
    if (existing) {
      if (existing.derivation !== undefined) {
        throw new Error(`fact ${input.fact_id} is derived; cannot overwrite via putSourceFact`);
      }
      if (existing.value.eq(input.value)) return existing; // no-op, no audit row
      const status: FactStatus = input.confirmed === true ? 'confirmed' : 'unconfirmed';
      await this.tx(async () => {
        await this.exec(
          `update tax_facts set value = $3::numeric, status = $4, confidence = $5
            where workspace_id = $1 and fact_id = $2`,
          [this.ws, input.fact_id, input.value.toString(), status, input.confidence],
        );
        await this.setStale(await this.dependentIdsOf(input.fact_id));
      });
      return { ...existing, value: input.value, status, confidence: input.confidence };
    }
    const sourceIds = [...new Set(input.provenance.map((p) => p.source_id))];
    const known = await this.exec(
      `select source_id from sources where workspace_id = $1 and source_id = any($2)`,
      [this.ws, sourceIds],
    );
    if (known.rowCount !== sourceIds.length) {
      throw new Error(`putSourceFact ${input.fact_id}: unknown source in provenance`);
    }
    const status: FactStatus = input.confirmed === true ? 'confirmed' : 'unconfirmed';
    await this.tx(async () => {
      await this.exec(
        `insert into tax_facts (workspace_id, fact_id, concept, tax_year, jurisdictions, taxpayer_scope,
                                value, unit, status, confidence, derivation_calc_id)
         values ($1, $2, $3, $4, $5, $6, $7::numeric, 'USD', $8, $9, null)`,
        [
          input.taxpayer_id, input.fact_id, input.concept, input.tax_year, input.jurisdiction,
          input.taxpayer_scope, input.value.toString(), status, input.confidence,
        ],
      );
      for (const p of input.provenance) {
        await this.exec(
          `insert into fact_provenance (workspace_id, fact_id, source_id, source_field)
           values ($1, $2, $3, $4)`,
          [input.taxpayer_id, input.fact_id, p.source_id, p.source_field],
        );
      }
    });
    return {
      fact_id: input.fact_id,
      taxpayer_id: input.taxpayer_id,
      concept: input.concept,
      tax_year: input.tax_year,
      jurisdiction: input.jurisdiction,
      taxpayer_scope: input.taxpayer_scope,
      value: input.value,
      unit: 'USD',
      status,
      confidence: input.confidence,
      provenance: input.provenance,
    };
  }

  async confirmFact(fact_id: string): Promise<void> {
    const existing = await this.factById(fact_id);
    if (!existing) throw new Error(`fact ${fact_id} not found`);
    if (existing.status === 'confirmed') return; // no audit row
    await this.exec(
      `update tax_facts set status = 'confirmed' where workspace_id = $1 and fact_id = $2`,
      [this.ws, fact_id],
    );
  }

  private async dependentIdsOf(fact_id: string): Promise<string[]> {
    const depRes = await this.exec(
      `with recursive deps as (
         select output_fact_id from fact_dependencies where workspace_id = $1 and input_fact_id = $2
         union
         select fd.output_fact_id
           from fact_dependencies fd
           join deps d on fd.input_fact_id = d.output_fact_id
          where fd.workspace_id = $1
       )
       select output_fact_id from deps`,
      [this.ws, fact_id],
    );
    return depRes.rows.map((r) => r.output_fact_id as string);
  }

  private async setStale(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.exec(
      `update tax_facts set status = 'stale'
        where workspace_id = $1 and fact_id = any($2) and status <> 'stale'`,
      [this.ws, ids],
    );
  }

  async markStale(fact_id: string): Promise<StalenessImpact> {
    const origin = await this.factById(fact_id);
    if (!origin) throw new Error(`fact ${fact_id} not found`);

    const stale = new Set<string>(await this.dependentIdsOf(fact_id));
    if (origin.derivation !== undefined) stale.add(fact_id);
    await this.setStale([...stale]);

    const affected = [fact_id, ...stale];
    const gateRes = await this.exec(
      `select gate, jurisdiction from (
         select distinct on (gate, jurisdiction) gate, jurisdiction, consumed_fact_ids
           from gate_runs
          where workspace_id = $1
          order by gate, jurisdiction, ts desc, run_id desc
       ) latest
       where latest.consumed_fact_ids && $2::text[]
       order by gate, jurisdiction`,
      [this.ws, affected],
    );
    return {
      stale_fact_ids: [...stale].sort(),
      reopened_gates: gateRes.rows.map((r) => ({
        gate: r.gate as GateId,
        jurisdiction: r.jurisdiction as Jurisdiction,
      })),
    };
  }

  async appendGateRun(input: GateRunInput): Promise<GateRun> {
    const seqRes = await this.exec(`select nextval('gate_run_seq') as n`);
    const run_id = `gaterun-pg-${String(seqRes.rows[0].n).padStart(6, '0')}`;
    const nowRes = await this.exec(`select now()::timestamptz as t`);
    const ts = (nowRes.rows[0].t as Date).toISOString();
    await this.tx(async () => {
      await this.exec(
        `insert into gate_runs (workspace_id, run_id, tax_year, gate, jurisdiction, rule_version, started, result, consumed_fact_ids, ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7)`,
        [
          input.taxpayer_id, run_id, (input as { tax_year?: number }).tax_year ?? 0,
          input.gate, input.jurisdiction, input.rule_version, ts, input.result,
          [...input.consumed_fact_ids].sort(),
        ],
      );
      for (const f of input.findings) {
        await this.exec(
          `insert into findings (workspace_id, finding_id, gate_run_id, critic_id, severity, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [input.taxpayer_id, f.finding_id, run_id, f.critic_id, f.severity, JSON.stringify(f)],
        );
      }
    });
    return {
      run_id,
      taxpayer_id: input.taxpayer_id,
      gate: input.gate,
      jurisdiction: input.jurisdiction,
      rule_version: input.rule_version,
      started: ts,
      result: input.result,
      findings: input.findings,
      consumed_fact_ids: [...input.consumed_fact_ids].sort(),
      timestamp: ts,
    };
  }

  async getLineage(fact_id: string): Promise<LineageNode> {
    return this.lineageOf(fact_id, new Set());
  }

  private async lineageOf(fact_id: string, seen: Set<string>): Promise<LineageNode> {
    if (seen.has(fact_id)) throw new Error(`lineage cycle at ${fact_id}`);
    seen.add(fact_id);
    const fact = await this.factById(fact_id);
    if (!fact) throw new Error(`fact ${fact_id} not found`);
    if (fact.derivation !== undefined) {
      const calcRes = await this.exec(
        `select calc_id, workspace_id as taxpayer_id, concept, output_fact_id, rule_version,
                formula_ref, steps, value::text as value, terms, clamp_zero
           from calculations where workspace_id = $1 and calc_id = $2`,
        [this.ws, fact.derivation],
      );
      const c = calcRes.rows[0];
      if (!c) throw new Error(`fact ${fact_id}: missing calculation ${fact.derivation}`);
      const inputsRes = await this.exec(
        `select input_fact_id from fact_dependencies where workspace_id = $1 and calc_id = $2 order by input_fact_id`,
        [this.ws, c.calc_id],
      );
      const calculation = rowToCalc(c, inputsRes.rows.map((r) => r.input_fact_id as string));
      const inputs: LineageNode[] = [];
      for (const id of calculation.inputs) {
        inputs.push(await this.lineageOf(id, new Set(seen)));
      }
      return { fact, calculation, inputs };
    }
    const sources: SourceDoc[] = [];
    for (const p of fact.provenance ?? []) {
      const res = await this.exec(
        `select source_id, workspace_id as taxpayer_id, type, tax_year, fields, ocr_confidence, raw_ref, review_status
           from sources where workspace_id = $1 and source_id = $2`,
        [this.ws, p.source_id],
      );
      const r = res.rows[0];
      if (!r) throw new Error(`fact ${fact_id}: missing source ${p.source_id}`);
      sources.push({
        source_id: r.source_id,
        taxpayer_id: r.taxpayer_id,
        type: r.type,
        tax_year: r.tax_year,
        fields: r.fields,
        ocr_confidence: Number(r.ocr_confidence),
        raw_ref: r.raw_ref,
        review_status: r.review_status,
      });
    }
    return { fact, sources };
  }

  // ---------- ComputationSink ----------

  async commitComputation(result: ComputationResult): Promise<string[]> {
    const changed: string[] = [];
    const calcByOutput = new Map<string, Calculation>();
    for (const calc of result.calculations) calcByOutput.set(calc.output_fact_id, calc);

    for (const computed of result.computedFacts) {
      const calc = calcByOutput.get(computed.fact_id);
      if (!calc) {
        throw new Error(`commitComputation: derived fact ${computed.fact_id} has no Calculation record`);
      }
      if (computed.provenance !== undefined) {
        throw new Error(`commitComputation: derived fact ${computed.fact_id} must not carry provenance`);
      }
      if (computed.taxpayer_id !== this.ws) {
        throw new Error(
          `commitComputation: derived fact ${computed.fact_id} belongs to workspace ${computed.taxpayer_id}, not ${this.ws} — refusing a cross-workspace write`,
        );
      }
      const existing = await this.factById(computed.fact_id);
      if (existing && existing.derivation === undefined) {
        throw new Error(`fact ${computed.fact_id} is sourced; kernel cannot overwrite it`);
      }
      let unchanged = false;
      if (existing && existing.status !== 'stale' && existing.value.eq(computed.value)) {
        const priorCalc = await this.exec(
          `select rule_version, formula_ref from calculations where workspace_id = $1 and calc_id = $2`,
          [this.ws, existing.derivation],
        );
        const pc = priorCalc.rows[0];
        unchanged = pc !== undefined && pc.rule_version === calc.rule_version && pc.formula_ref === calc.formula_ref;
      }
      if (unchanged) continue; // idempotent recompute: no DML, no audit rows

      await this.tx(async () => {
        await this.exec(
          `insert into tax_facts (workspace_id, fact_id, concept, tax_year, jurisdictions, taxpayer_scope,
                                  value, unit, status, confidence, derivation_calc_id)
           values ($1, $2, $3, $4, $5, $6, $7::numeric, 'USD', 'confirmed', $8, $9)
           on conflict (workspace_id, fact_id) do update
             set value = excluded.value, status = 'confirmed', derivation_calc_id = excluded.derivation_calc_id`,
          [
            computed.taxpayer_id, computed.fact_id, computed.concept, computed.tax_year,
            computed.jurisdiction, computed.taxpayer_scope, computed.value.toString(),
            computed.confidence, calc.calc_id,
          ],
        );
        await this.exec(
          `insert into calculations (workspace_id, calc_id, concept, output_fact_id, rule_version,
                                     formula_ref, steps, value, terms, clamp_zero)
           values ($1, $2, $3, $4, $5, $6, $7::text[], $8::numeric, $9::jsonb, $10)
           on conflict (workspace_id, calc_id) do update
             set rule_version = excluded.rule_version, formula_ref = excluded.formula_ref,
                 steps = excluded.steps, value = excluded.value,
                 terms = excluded.terms, clamp_zero = excluded.clamp_zero`,
          [
            calc.taxpayer_id, calc.calc_id, calc.concept, calc.output_fact_id, calc.rule_version,
            calc.formula_ref, calc.steps, calc.value.toString(),
            calc.terms ? JSON.stringify(calc.terms) : null, calc.clamp_zero === true,
          ],
        );
        for (const inputId of calc.inputs) {
          await this.exec(
            `insert into fact_dependencies (workspace_id, calc_id, input_fact_id, output_fact_id)
             values ($1, $2, $3, $4) on conflict do nothing`,
            [calc.taxpayer_id, calc.calc_id, inputId, calc.output_fact_id],
          );
        }
      });
      changed.push(computed.fact_id);
    }
    return changed;
  }

  // ---------- Inspectable ----------

  async inspect(taxpayer_id?: string): Promise<{
    auditLog: readonly AuditLogEntry[];
    gateRuns: readonly GateRun[];
    calculations: readonly Calculation[];
  }> {
    const ws = taxpayer_id ?? this.ws;
    const gateRes = await this.exec(
      `select run_id, workspace_id as taxpayer_id, gate, jurisdiction, rule_version, started, result, consumed_fact_ids, ts
         from gate_runs where workspace_id = $1 order by ts, run_id`,
      [ws],
    );
    const gateRuns: GateRun[] = [];
    for (const g of gateRes.rows) {
      const findRes = await this.exec(
        `select payload from findings where workspace_id = $1 and gate_run_id = $2 order by finding_id`,
        [ws, g.run_id],
      );
      gateRuns.push({
        run_id: g.run_id,
        taxpayer_id: g.taxpayer_id,
        gate: g.gate,
        jurisdiction: g.jurisdiction,
        rule_version: g.rule_version,
        started: (g.started as Date).toISOString(),
        result: g.result,
        findings: findRes.rows.map((f) => f.payload as Finding),
        consumed_fact_ids: g.consumed_fact_ids,
        timestamp: (g.ts as Date).toISOString(),
      });
    }

    const calcRes = await this.exec(
      `select calc_id, workspace_id as taxpayer_id, concept, output_fact_id, rule_version,
              formula_ref, steps, value::text as value, terms, clamp_zero
         from calculations where workspace_id = $1 order by calc_id`,
      [ws],
    );
    const calculations: Calculation[] = [];
    for (const c of calcRes.rows) {
      const inputsRes = await this.exec(
        `select input_fact_id from fact_dependencies where workspace_id = $1 and calc_id = $2 order by input_fact_id`,
        [ws, c.calc_id],
      );
      calculations.push(rowToCalc(c, inputsRes.rows.map((r) => r.input_fact_id as string)));
    }

    // The trigger-written audit trail: action strings are '<op> <table>' with
    // the row's natural id in detail (0003). Mapped onto the shared entry
    // shape; spine entity types only (workspace/settings rows are visible to
    // ops tooling directly).
    const TABLE_TO_ENTITY: Record<string, AuditLogEntry['entity_type']> = {
      sources: 'source', tax_facts: 'tax_fact', calculations: 'calculation',
      gate_runs: 'gate_run', registers: 'register',
    };
    const auditRes = await this.exec(
      `select seq, ts, actor, action, detail from audit_log where workspace_id = $1 order by seq`,
      [ws],
    );
    const auditLog: AuditLogEntry[] = [];
    for (const a of auditRes.rows) {
      const detail = a.detail as { op?: string; table?: string; id?: string };
      const entity = TABLE_TO_ENTITY[detail.table ?? ''];
      if (!entity) continue;
      auditLog.push({
        seq: Number(a.seq),
        at: (a.ts as Date).toISOString(),
        actor: a.actor,
        action: a.action as AuditLogEntry['action'],
        entity_type: entity,
        entity_id: detail.id ?? '',
        details: detail,
      });
    }

    return { auditLog, gateRuns, calculations };
  }
}

// ---------------------------------------------------------------- ops helpers

/** Create a workspace owned by this auth user (idempotent) and return its id. */
export async function ensureWorkspace(
  config: pg.ClientConfig,
  input: { workspace_id: string; auth_user_id: string; display_name: string },
): Promise<void> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: input.auth_user_id, role: 'authenticated' }),
    ]);
    await client.query(
      `insert into workspaces (workspace_id, display_name, created_by) values ($1, $2, $3)
       on conflict (workspace_id) do nothing`,
      [input.workspace_id, input.display_name, input.auth_user_id],
    );
    await client.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')
       on conflict (workspace_id, user_id) do nothing`,
      [input.workspace_id, input.auth_user_id],
    );
  } finally {
    await client.end();
  }
}

/** Every workspace this auth user belongs to, oldest first. */
export async function listWorkspaces(
  config: pg.ClientConfig,
  auth_user_id: string,
): Promise<{ workspace_id: string; display_name: string; role: string }[]> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: auth_user_id, role: 'authenticated' }),
    ]);
    const res = await client.query(
      `select w.workspace_id, w.display_name, m.role
         from workspaces w join workspace_members m
           on m.workspace_id = w.workspace_id and m.user_id = $1
        order by w.created_at`,
      [auth_user_id],
    );
    return res.rows as { workspace_id: string; display_name: string; role: string }[];
  } finally {
    await client.end();
  }
}

/**
 * Workspace lifecycle. Both call the owner-guarded SQL functions from
 * migration 0005 rather than issuing the deletes here: the wall has to be in
 * the database (a reviewer with a stolen session must be refused by Postgres,
 * not by whichever caller remembered to check), and one transaction per
 * operation means a half-emptied workspace is not a reachable state.
 *
 * Both return the storage refs of documents that were stored, so the caller
 * can clear the bucket in the same operation. The audit log is deliberately
 * NOT cleared: the record that a wipe happened is the point of a trail.
 */
export interface LifecycleResult {
  /** Storage object names the caller should now remove from the bucket. */
  raw_refs: string[];
  /** Rows removed, per table — surfaced to the operator, not just discarded. */
  deleted: Record<string, number>;
}

async function callLifecycle(
  config: pg.ClientConfig,
  auth_user_id: string,
  fn: 'reset_workspace' | 'delete_workspace',
  workspace_id: string,
): Promise<LifecycleResult> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: auth_user_id, role: 'authenticated' }),
    ]);
    const res = await client.query(`select ${fn}($1) as out`, [workspace_id]);
    const out = res.rows[0].out as { raw_refs: string[]; deleted: Record<string, number> };
    return { raw_refs: out.raw_refs ?? [], deleted: out.deleted ?? {} };
  } finally {
    await client.end();
  }
}

/** Empty a workspace, keeping the workspace itself and its members. */
export function resetWorkspace(
  config: pg.ClientConfig,
  auth_user_id: string,
  workspace_id: string,
): Promise<LifecycleResult> {
  return callLifecycle(config, auth_user_id, 'reset_workspace', workspace_id);
}

/** Remove a workspace entirely, members included. */
export function deleteWorkspace(
  config: pg.ClientConfig,
  auth_user_id: string,
  workspace_id: string,
): Promise<LifecycleResult> {
  return callLifecycle(config, auth_user_id, 'delete_workspace', workspace_id);
}
