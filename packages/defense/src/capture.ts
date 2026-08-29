/**
 * G.5 — Year-round capture engine: mileage log, receipt vault, income
 * ledger. APPEND-ONLY + TIMESTAMPS ARE THE PRODUCT: a record's evidentiary
 * value IS its contemporaneity (Pub 463), so edits create new versions and
 * never rewrite history; created_at is set by the store's clock at insert
 * and is immutable.
 *
 * Substance check (§274(d), harvested): a timestamp proves WHEN, not WHAT.
 * Generic purposes are marked substantiation:'incomplete' with a real-time
 * completeness prompt and stay OUT of the Defense File until corrected.
 */
import { Money, PLACEHOLDER, type Clock } from '@taxfs/shared';

export interface CaptureRules {
  generic_purpose_patterns: string[];
  min_specific_purpose_length: number;
  completeness_prompt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadCaptureRules(json: unknown): CaptureRules {
  if (!isRecord(json)) throw new Error('capture rules: expected object');
  const patterns = json['generic_purpose_patterns'];
  const minLen = json['min_specific_purpose_length'];
  const prompt = json['completeness_prompt'];
  for (const [name, fig] of Object.entries({ generic_purpose_patterns: patterns, min_specific_purpose_length: minLen, completeness_prompt: prompt })) {
    if (!isRecord(fig) || fig['status'] !== PLACEHOLDER) {
      throw new Error(`capture rules ${name}: missing "${PLACEHOLDER}" marker`);
    }
  }
  return {
    generic_purpose_patterns: ((patterns as Record<string, unknown>)['value'] as unknown[]).map(String),
    min_specific_purpose_length: Number((minLen as Record<string, unknown>)['value']),
    completeness_prompt: String((prompt as Record<string, unknown>)['value']),
  };
}

export type Substantiation = 'complete' | 'incomplete';

export function assessPurpose(purpose: string, rules: CaptureRules): { substantiation: Substantiation; prompt?: string } {
  const p = purpose.trim().toLowerCase();
  const generic =
    p.length < rules.min_specific_purpose_length ||
    rules.generic_purpose_patterns.some((g) => p === g.toLowerCase());
  return generic ? { substantiation: 'incomplete', prompt: rules.completeness_prompt } : { substantiation: 'complete' };
}

interface BaseRecord {
  record_id: string;
  /** Root id of the version chain (stable across edits). */
  chain_id: string;
  version: number;
  supersedes?: string;
  /** Immutable: assigned from the store clock at insert. Contemporaneity IS the evidence. */
  created_at: string;
  substantiation: Substantiation;
  completeness_prompt?: string;
}

export interface MileageEntry extends BaseRecord {
  kind: 'mileage';
  trip_date: string;
  purpose: string;
  miles: string; // decimal string
}

export interface ReceiptEntry extends BaseRecord {
  kind: 'receipt';
  receipt_date: string;
  payee: string;
  amount: string; // decimal string
  purpose: string;
  photo_ref: string;
}

export interface IncomeLedgerEntry {
  record_id: string;
  created_at: string;
  income_date: string;
  source: string;
  amount: string;
  note?: string;
}

export type CaptureRecord = MileageEntry | ReceiptEntry;

export class CaptureStore {
  private readonly records: CaptureRecord[] = [];
  private readonly income: IncomeLedgerEntry[] = [];
  private seq = 0;

  constructor(
    private readonly clock: Clock,
    private readonly rules: CaptureRules,
  ) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  addMileage(input: { trip_date: string; purpose: string; miles: string }): MileageEntry {
    Money.fromString(input.miles); // decimal-string discipline
    const id = this.nextId('mi');
    const assessed = assessPurpose(input.purpose, this.rules);
    const entry: MileageEntry = {
      kind: 'mileage',
      record_id: id,
      chain_id: id,
      version: 1,
      created_at: this.clock.nowIso(),
      trip_date: input.trip_date,
      purpose: input.purpose,
      miles: input.miles,
      substantiation: assessed.substantiation,
      ...(assessed.prompt ? { completeness_prompt: assessed.prompt } : {}),
    };
    this.records.push(Object.freeze(entry));
    return entry;
  }

  addReceipt(input: { receipt_date: string; payee: string; amount: string; purpose: string; photo_ref: string }): ReceiptEntry {
    Money.fromString(input.amount);
    const id = this.nextId('rc');
    const assessed = assessPurpose(input.purpose, this.rules);
    const entry: ReceiptEntry = {
      kind: 'receipt',
      record_id: id,
      chain_id: id,
      version: 1,
      created_at: this.clock.nowIso(),
      receipt_date: input.receipt_date,
      payee: input.payee,
      amount: input.amount,
      purpose: input.purpose,
      photo_ref: input.photo_ref,
      substantiation: assessed.substantiation,
      ...(assessed.prompt ? { completeness_prompt: assessed.prompt } : {}),
    };
    this.records.push(Object.freeze(entry));
    return entry;
  }

  /**
   * Append-only edit: a NEW version is appended with its own created_at;
   * the prior version is retained untouched. There is no update or delete.
   */
  amend(record_id: string, changes: { purpose?: string; miles?: string; amount?: string }): CaptureRecord {
    const prior = this.records.find((r) => r.record_id === record_id);
    if (!prior) throw new Error(`capture record ${record_id} not found`);
    const head = this.latestOfChain(prior.chain_id);
    if (head.record_id !== record_id) {
      throw new Error(`capture record ${record_id} is superseded by ${head.record_id}; amend the latest version`);
    }
    const purpose = changes.purpose ?? head.purpose;
    const assessed = assessPurpose(purpose, this.rules);
    const base = {
      record_id: this.nextId(head.kind === 'mileage' ? 'mi' : 'rc'),
      chain_id: head.chain_id,
      version: head.version + 1,
      supersedes: head.record_id,
      created_at: this.clock.nowIso(),
      substantiation: assessed.substantiation,
      ...(assessed.prompt ? { completeness_prompt: assessed.prompt } : {}),
    };
    let entry: CaptureRecord;
    if (head.kind === 'mileage') {
      if (changes.miles) Money.fromString(changes.miles);
      entry = { ...head, ...base, kind: 'mileage', purpose, miles: changes.miles ?? head.miles };
    } else {
      if (changes.amount) Money.fromString(changes.amount);
      entry = { ...head, ...base, kind: 'receipt', purpose, amount: changes.amount ?? head.amount };
    }
    this.records.push(Object.freeze(entry));
    return entry;
  }

  addIncome(input: { income_date: string; source: string; amount: string; note?: string }): IncomeLedgerEntry {
    Money.fromString(input.amount);
    const entry: IncomeLedgerEntry = {
      record_id: this.nextId('inc'),
      created_at: this.clock.nowIso(),
      income_date: input.income_date,
      source: input.source,
      amount: input.amount,
      ...(input.note ? { note: input.note } : {}),
    };
    this.income.push(Object.freeze(entry));
    return entry;
  }

  latestOfChain(chain_id: string): CaptureRecord {
    const chain = this.records.filter((r) => r.chain_id === chain_id);
    const head = chain[chain.length - 1];
    if (!head) throw new Error(`capture chain ${chain_id} not found`);
    return head;
  }

  /** Full history including superseded versions — nothing is ever rewritten. */
  history(chain_id: string): CaptureRecord[] {
    return this.records.filter((r) => r.chain_id === chain_id);
  }

  /** Latest version per chain (what the UI lists). */
  current(): CaptureRecord[] {
    const heads = new Map<string, CaptureRecord>();
    for (const r of this.records) heads.set(r.chain_id, r);
    return [...heads.values()];
  }

  /** Only substantiation-complete heads qualify for the Defense File (G.5). */
  defenseEligible(): CaptureRecord[] {
    return this.current().filter((r) => r.substantiation === 'complete');
  }

  incomeLedger(): readonly IncomeLedgerEntry[] {
    return this.income;
  }

  // ---- persistence (TaxFS addition) -------------------------------------
  // TaxOS held this store in the server session, so capture records — whose
  // entire evidentiary value is their contemporaneity — vanished on every
  // restart. TaxFS snapshots the full append-only state and reconstructs it
  // verbatim; created_at values persist untouched, so the timestamps stay
  // the product.

  toSnapshot(): CaptureSnapshot {
    return { records: [...this.records], income: [...this.income], seq: this.seq };
  }

  static fromSnapshot(clock: Clock, rules: CaptureRules, snap: CaptureSnapshot | null): CaptureStore {
    const store = new CaptureStore(clock, rules);
    if (snap) {
      for (const r of snap.records) store.records.push(Object.freeze({ ...r }));
      for (const e of snap.income) store.income.push(Object.freeze({ ...e }));
      store.seq = snap.seq;
    }
    return store;
  }
}

export interface CaptureSnapshot {
  records: CaptureRecord[];
  income: IncomeLedgerEntry[];
  seq: number;
}
