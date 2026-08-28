/**
 * G.4 — Benchmark & reference data lifecycle (Cap 23).
 * Versioned imports with source/date stamps, schema-validated, consumed
 * read-only. NO LLM-GENERATED BENCHMARK VALUES EVER (§5.6.4): the only way
 * data enters this store is a versioned release load, and every memo that
 * uses it cites dataset + version + vintage. Dataset updates are releases,
 * regression-gated against golden comp memos.
 */
import { Money, PLACEHOLDER, type Clock } from '@taxfs/shared';

export interface BenchmarkRow {
  soc_code: string;
  title: string;
  area: string;
  p25: string;
  p50: string;
  p75: string;
}

export interface BenchmarkRelease {
  dataset: string;
  version: string;
  vintage: string;
  source_ref: string;
  rows: BenchmarkRow[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER || typeof raw['value'] !== 'string') {
    throw new Error(`benchmark release ${path}: figure with "${PLACEHOLDER}" marker required`);
  }
  Money.fromString(raw['value']); // must be a decimal string
  return raw['value'];
}

export function loadBenchmarkRelease(json: unknown): BenchmarkRelease {
  if (!isRecord(json) || !Array.isArray(json['rows'])) throw new Error('benchmark release: expected { rows: [...] }');
  for (const key of ['dataset', 'version', 'vintage', 'source_ref']) {
    if (typeof json[key] !== 'string' || json[key] === '') throw new Error(`benchmark release: ${key} required`);
  }
  return {
    dataset: String(json['dataset']),
    version: String(json['version']),
    vintage: String(json['vintage']),
    source_ref: String(json['source_ref']),
    rows: json['rows'].map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`benchmark rows[${i}]: expected object`);
      return {
        soc_code: String(raw['soc_code']),
        title: String(raw['title']),
        area: String(raw['area']),
        p25: figure(raw['p25'], `rows[${i}].p25`),
        p50: figure(raw['p50'], `rows[${i}].p50`),
        p75: figure(raw['p75'], `rows[${i}].p75`),
      };
    }),
  };
}

export class BenchmarkStore {
  private readonly releases = new Map<string, BenchmarkRelease>(); // `${dataset}@${version}`

  load(release: BenchmarkRelease): void {
    const key = `${release.dataset}@${release.version}`;
    if (this.releases.has(key)) throw new Error(`benchmark release ${key} already loaded (releases are immutable)`);
    this.releases.set(key, release);
  }

  get(dataset: string, version: string): BenchmarkRelease {
    const release = this.releases.get(`${dataset}@${version}`);
    if (!release) throw new Error(`benchmark release ${dataset}@${version} not loaded`);
    return release;
  }

  citation(dataset: string, version: string): string {
    const r = this.get(dataset, version);
    return `${r.dataset} ${r.version} (vintage: ${r.vintage}; source: ${r.source_ref})`;
  }
}

/**
 * Fixture comp-memo builder (§5.5 shape, "Many Hats" slice): substance
 * first, a RANGE never a floor, every figure cited to dataset+version+
 * vintage. The full Reasonable-Comp Engine arrives with S-corp scope
 * (step 5); this exercises the citation + regression discipline now.
 */
export interface CompMemo {
  memo_id: string;
  generated_at: string;
  substance_analysis: string;
  roles: { soc_code: string; title: string; weight_pct: string; p25: string; p75: string }[];
  range_low: string;
  range_high: string;
  citations: string[];
  language_note: string;
}

export function buildCompMemo(input: {
  store: BenchmarkStore;
  dataset: string;
  version: string;
  clock: Clock;
  revenue_source_analysis: string;
  roles: { soc_code: string; weight_pct: string }[];
}): CompMemo {
  const release = input.store.get(input.dataset, input.version);
  let low = Money.zero();
  let high = Money.zero();
  const roles = input.roles.map((role) => {
    const row = release.rows.find((r) => r.soc_code === role.soc_code);
    if (!row) throw new Error(`comp memo: SOC ${role.soc_code} not in ${input.dataset}@${input.version}`);
    low = low.add(Money.fromString(row.p25).mulRate(role.weight_pct));
    high = high.add(Money.fromString(row.p75).mulRate(role.weight_pct));
    return { soc_code: row.soc_code, title: row.title, weight_pct: role.weight_pct, p25: row.p25, p75: row.p75 };
  });
  return {
    memo_id: `compmemo-${input.dataset}-${input.version}`,
    generated_at: input.clock.nowIso(),
    substance_analysis: input.revenue_source_analysis,
    roles,
    range_low: low.roundToDollar().toString(),
    range_high: high.roundToDollar().toString(),
    citations: [input.store.citation(input.dataset, input.version)],
    language_note:
      'This is a defensible RANGE centered on the substance analysis above — it is not a floor, and no single number is auto-selected.',
  };
}
