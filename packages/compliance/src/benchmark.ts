/**
 * J.1 — Accuracy-proof benchmark harness (Build Plan §19).
 * Compares kernel output line-by-line against an INDEPENDENTLY prepared
 * professional return fixture and reports every delta. Run per rule-set
 * release; the report attaches to the release record. Real professional
 * benchmark returns are a procurement item — the fixture is a PLACEHOLDER
 * stand-in that exercises the pipeline.
 */
import { Money, type FilingStatus, type Jurisdiction, type TaxFact, type TaxpayerScope } from '@taxfs/shared';

export interface ProfessionalBenchmark {
  benchmark_id: string;
  prepared_by: string;
  source_golden: string;
  expected_lines: Record<string, string>;
}

/** A benchmark RETURN: the professional return's input facts + filing meta,
 *  plus its computed line outputs (a ProfessionalBenchmark). The harness runs
 *  the inputs through the kernel on verified rule-data and compares. */
export interface BenchmarkReturnFact {
  fact_id: string;
  concept: string;
  value: string;
  jurisdiction: Jurisdiction[];
  scope?: TaxpayerScope;
}

/** A line where TaxFS is EXPECTED to differ from the preparer's return — e.g.
 *  Venkat's §469(i) rental allowance, where the preparer's Form 8582 MAGI was
 *  impossible and TaxFS computes the correct (smaller) allowance. The harness
 *  does NOT assert these against the preparer; it records them so a real return
 *  with a known preparer error can still be anchored on every OTHER line
 *  without the disputed line failing the tie. `expected_lines` for a divergent
 *  concept therefore hold TaxFS's own (corrected) value, documented here. */
export interface PreparerDivergence {
  preparer_value: string;
  reason: string;
}

export interface BenchmarkReturn {
  benchmark: ProfessionalBenchmark;
  filing_status: FilingStatus;
  il_exemption_count: number;
  addl_std_boxes: number;
  input_facts: BenchmarkReturnFact[];
  /** Optional: concepts where TaxFS deliberately diverges from the preparer. */
  preparer_divergences: Record<string, PreparerDivergence>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadProfessionalBenchmark(json: unknown): ProfessionalBenchmark {
  if (
    !isRecord(json) ||
    typeof json['benchmark_id'] !== 'string' ||
    typeof json['prepared_by'] !== 'string' ||
    !isRecord(json['expected_lines'])
  ) {
    throw new Error('professional benchmark: expected { benchmark_id, prepared_by, expected_lines }');
  }
  if (!json['benchmark_id'].includes('PLACEHOLDER') && !json['prepared_by'].toLowerCase().includes('verified')) {
    throw new Error('professional benchmark: unverified real-looking benchmark refused (PLACEHOLDER or verified attribution required)');
  }
  const expected: Record<string, string> = {};
  for (const [concept, value] of Object.entries(json['expected_lines'])) {
    Money.fromString(String(value));
    expected[concept] = String(value);
  }
  return {
    benchmark_id: json['benchmark_id'],
    prepared_by: json['prepared_by'],
    source_golden: String(json['source_golden'] ?? ''),
    expected_lines: expected,
  };
}

const FILING_STATUSES: FilingStatus[] = ['single', 'mfj', 'mfs', 'hoh', 'qss'];

export function loadBenchmarkReturn(json: unknown): BenchmarkReturn {
  if (!isRecord(json) || !Array.isArray(json['input_facts'])) {
    throw new Error('benchmark return: expected { input_facts: [...], filing_status, il_exemption_count, expected_lines }');
  }
  const fs = json['filing_status'];
  if (typeof fs !== 'string' || !FILING_STATUSES.includes(fs as FilingStatus)) {
    throw new Error('benchmark return: filing_status must be single|mfj|mfs|hoh|qss');
  }
  if (typeof json['il_exemption_count'] !== 'number') {
    throw new Error('benchmark return: il_exemption_count (number) required');
  }
  const input_facts: BenchmarkReturnFact[] = json['input_facts'].map((f, i) => {
    if (
      !isRecord(f) ||
      typeof f['fact_id'] !== 'string' ||
      typeof f['concept'] !== 'string' ||
      typeof f['value'] !== 'string' ||
      !Array.isArray(f['jurisdiction'])
    ) {
      throw new Error(`benchmark return input_facts[${i}]: { fact_id, concept, value, jurisdiction[] } required`);
    }
    Money.fromString(f['value']); // value must be a decimal string
    return {
      fact_id: f['fact_id'],
      concept: f['concept'],
      value: f['value'],
      jurisdiction: (f['jurisdiction'] as unknown[]).map((j) => (j === 'IL' ? 'IL' : 'FED')) as Jurisdiction[],
      ...(typeof f['scope'] === 'string' ? { scope: f['scope'] as TaxpayerScope } : {}),
    };
  });
  const divergences: Record<string, PreparerDivergence> = {};
  const rawDiv = json['preparer_divergences'];
  if (rawDiv !== undefined) {
    if (!isRecord(rawDiv)) throw new Error('benchmark return: preparer_divergences must be an object keyed by concept');
    for (const [concept, d] of Object.entries(rawDiv)) {
      if (!isRecord(d) || typeof d['preparer_value'] !== 'string' || typeof d['reason'] !== 'string') {
        throw new Error(`benchmark return: preparer_divergences.${concept} needs { preparer_value, reason } (both strings)`);
      }
      Money.fromString(d['preparer_value']); // must be a decimal string
      divergences[concept] = { preparer_value: d['preparer_value'], reason: d['reason'] };
    }
  }
  return {
    benchmark: loadProfessionalBenchmark(json),
    filing_status: fs as FilingStatus,
    il_exemption_count: json['il_exemption_count'],
    addl_std_boxes: typeof json['addl_std_boxes'] === 'number' ? json['addl_std_boxes'] : 0,
    input_facts,
    preparer_divergences: divergences,
  };
}

export interface BenchmarkDelta {
  concept: string;
  ours: string;
  professional: string;
  difference: string;
}

export interface BenchmarkReport {
  benchmark_id: string;
  lines_compared: number;
  matches: number;
  deltas: BenchmarkDelta[];
  clean: boolean;
}

export function runAccuracyBenchmark(
  benchmark: ProfessionalBenchmark,
  computedFacts: TaxFact[],
): BenchmarkReport {
  const byConcept = new Map(
    computedFacts.filter((f) => f.derivation !== undefined).map((f) => [f.concept, f.value]),
  );
  const deltas: BenchmarkDelta[] = [];
  let matches = 0;
  for (const [concept, expected] of Object.entries(benchmark.expected_lines)) {
    const ours = byConcept.get(concept);
    const professional = Money.fromString(expected);
    if (ours && ours.eq(professional)) {
      matches += 1;
    } else {
      deltas.push({
        concept,
        ours: ours ? ours.toString() : '<missing>',
        professional: expected,
        difference: ours ? ours.sub(professional).toString() : '<missing>',
      });
    }
  }
  return {
    benchmark_id: benchmark.benchmark_id,
    lines_compared: Object.keys(benchmark.expected_lines).length,
    matches,
    deltas,
    clean: deltas.length === 0,
  };
}

/** Golden-layer comparator (used by the pyramid seeded-defect proof). */
export function compareGoldenExpectations(
  computedFacts: TaxFact[],
  expected: Record<string, string>,
): BenchmarkDelta[] {
  return runAccuracyBenchmark(
    { benchmark_id: 'golden', prepared_by: 'golden PLACEHOLDER', source_golden: '', expected_lines: expected },
    computedFacts,
  ).deltas;
}
