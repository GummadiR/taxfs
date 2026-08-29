/**
 * I.1/I.2 — FilingRecord, NoticeCase, AmendmentCase.
 * Marking Filed binds the locked package version and FREEZES the record:
 * there is no mutation API and the object is deep-frozen — post-filed
 * changes exist only as cases (I.2/I.7). The AUR procedural block lives
 * here: no standalone 1040-X while a CP2000/AUR case is open on the same
 * items (parallel filings cause duplicate assessments).
 */
import type { Clock } from '@taxfs/shared';
import type { PackageManifest } from '@taxfs/forms';
import type { AmendmentReason } from './rules';

export interface FilingRecord {
  filing_id: string;
  taxpayer_id: string;
  tax_year: number;
  package_id: string;
  package_version: number;
  channel: 'paper' | 'mef_xml';
  /** User-attested — TaxFS does not transmit and cannot know the true date. */
  filed_date: string;
  /** Column-A anchor for any later 1040-X: derived lines as filed. */
  baseline_lines: Record<string, string>;
  status: 'filed';
  created_at: string;
}

export type NoticeType = 'CP2000' | 'math_error' | 'correspondence' | 'other';

export interface NoticeItem {
  item_id: string;
  irs_claim: { form: string; payer: string; concept: string; amount: string; claim_kind: string };
  our_fact_refs: string[];
  assessment?: 'agree' | 'disagree';
}

export interface NoticeCase {
  case_id: string;
  filing_id: string;
  notice_type: NoticeType;
  notice_date: string;
  response_deadline: string;
  items: NoticeItem[];
  status: 'open' | 'responded' | 'closed';
}

export interface IlCompanion {
  due_date: string;
  alert: string;
  generated: boolean;
}

export interface AmendmentCase {
  amend_id: string;
  filing_id: string;
  reason: AmendmentReason;
  /** Concepts the correction touches (drives the AUR overlap check). */
  correction_concepts: string[];
  delta_facts: { fact_id: string; concept: string; old_value: string; new_value: string }[];
  explanation_statement?: string;
  new_package_ref?: string;
  il_companion?: IlCompanion;
  status: 'draft' | 'finalized';
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

export class PostFilingStore {
  private readonly filings: FilingRecord[] = [];
  private readonly noticeCases: NoticeCase[] = [];
  private readonly amendments: AmendmentCase[] = [];
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  /** I.2 — user marks the return Filed; requires the LOCKED package. */
  markFiled(input: {
    manifest: PackageManifest;
    channel: 'paper' | 'mef_xml';
    filed_date: string;
    baseline_lines: Record<string, string>;
  }): FilingRecord {
    if (input.manifest.status !== 'locked') {
      throw new Error('only a locked package version can be marked Filed');
    }
    if (this.filings.some((f) => f.package_id === input.manifest.package_id)) {
      throw new Error(`package ${input.manifest.package_id} is already marked Filed`);
    }
    const record: FilingRecord = deepFreeze({
      filing_id: this.nextId('filing'),
      taxpayer_id: input.manifest.taxpayer_id,
      tax_year: input.manifest.tax_year,
      package_id: input.manifest.package_id,
      package_version: input.manifest.version,
      channel: input.channel,
      filed_date: input.filed_date,
      baseline_lines: { ...input.baseline_lines },
      status: 'filed',
      created_at: this.clock.nowIso(),
    });
    this.filings.push(record);
    return record;
  }

  latestFiling(taxpayer_id: string, tax_year: number): FilingRecord | undefined {
    return [...this.filings].reverse().find((f) => f.taxpayer_id === taxpayer_id && f.tax_year === tax_year);
  }

  openNoticeCase(input: {
    filing: FilingRecord;
    notice_type: NoticeType;
    notice_date: string;
    response_deadline: string;
    items: Omit<NoticeItem, 'item_id'>[];
  }): NoticeCase {
    const noticeCase: NoticeCase = {
      case_id: this.nextId('notice'),
      filing_id: input.filing.filing_id,
      notice_type: input.notice_type,
      notice_date: input.notice_date,
      response_deadline: input.response_deadline,
      items: input.items.map((item) => ({ ...item, item_id: this.nextId('item') })),
      status: 'open',
    };
    this.noticeCases.push(noticeCase);
    return noticeCase;
  }

  setNoticeStatus(case_id: string, status: NoticeCase['status']): void {
    const c = this.noticeCases.find((x) => x.case_id === case_id);
    if (!c) throw new Error(`notice case ${case_id} not found`);
    c.status = status;
  }

  /** Concepts currently under an open AUR/CP2000 case for a filing. */
  private aurConcepts(filing_id: string): Set<string> {
    const out = new Set<string>();
    for (const c of this.noticeCases) {
      if (c.filing_id !== filing_id || c.status !== 'open' || c.notice_type !== 'CP2000') continue;
      for (const item of c.items) out.add(item.irs_claim.concept);
    }
    return out;
  }

  /**
   * I.3/I.7 — the AUR procedural block: a STANDALONE amendment touching an
   * item under an open CP2000 case is refused; resolution routes through
   * the notice's own response process (its included response form —
   * verify per notice). Amendments born FROM the notice outcome pass.
   */
  openAmendmentCase(input: {
    filing: FilingRecord;
    reason: AmendmentReason;
    correction_concepts: string[];
  }): AmendmentCase {
    if (input.reason !== 'notice_outcome') {
      const blocked = this.aurConcepts(input.filing.filing_id);
      const overlap = input.correction_concepts.filter((c) => blocked.has(c));
      if (overlap.length > 0) {
        throw new Error(
          `standalone 1040-X blocked: ${overlap.join(', ')} is under an open CP2000/AUR case. ` +
            'Respond through the notice case instead — a parallel amended return during an open AUR exam causes duplicate assessments and processing conflicts.',
        );
      }
    }
    const amend: AmendmentCase = {
      amend_id: this.nextId('amend'),
      filing_id: input.filing.filing_id,
      reason: input.reason,
      correction_concepts: [...input.correction_concepts],
      delta_facts: [],
      status: 'draft',
    };
    this.amendments.push(amend);
    return amend;
  }

  getAmendment(amend_id: string): AmendmentCase {
    const a = this.amendments.find((x) => x.amend_id === amend_id);
    if (!a) throw new Error(`amendment case ${amend_id} not found`);
    return a;
  }

  noticeCasesFor(filing_id: string): NoticeCase[] {
    return this.noticeCases.filter((c) => c.filing_id === filing_id);
  }

  amendmentsFor(filing_id: string): AmendmentCase[] {
    return this.amendments.filter((a) => a.filing_id === filing_id);
  }

  // ---- persistence (TaxFS addition) -------------------------------------
  // TaxOS held filings/cases in the server session — the FILED baseline,
  // the one record that must outlive everything, vanished on restart. The
  // snapshot round-trips the plain state; filings re-freeze on rehydration
  // so the no-mutation guarantee survives persistence.

  toSnapshot(): PostFilingSnapshot {
    return {
      filings: this.filings.map((f) => ({ ...f, baseline_lines: { ...f.baseline_lines } })),
      noticeCases: JSON.parse(JSON.stringify(this.noticeCases)) as NoticeCase[],
      amendments: JSON.parse(JSON.stringify(this.amendments)) as AmendmentCase[],
      seq: this.seq,
    };
  }

  static fromSnapshot(clock: Clock, snap: PostFilingSnapshot | null): PostFilingStore {
    const store = new PostFilingStore(clock);
    if (snap) {
      for (const f of snap.filings) store.filings.push(deepFreeze({ ...f }));
      for (const c of snap.noticeCases) store.noticeCases.push(c);
      for (const a of snap.amendments) store.amendments.push(a);
      store.seq = snap.seq;
    }
    return store;
  }
}

export interface PostFilingSnapshot {
  filings: FilingRecord[];
  noticeCases: NoticeCase[];
  amendments: AmendmentCase[];
  seq: number;
}
