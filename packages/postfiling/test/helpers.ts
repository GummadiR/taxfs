/** Post-filing test rig: a filed scenario + notice-extraction stub. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InMemoryAgentLog,
  LlmClient,
  ModelRouter,
  StubProvider,
  stubRouterConfig,
  type AgentRunDeps,
  type Clock,
  type TaxFact,
} from '@taxfs/shared';
import { seedScenario, type Scenario } from '@taxfs/gates';
import { PackageStore, buildPackage, type PackageManifest } from '@taxfs/forms';
import { PostFilingStore, loadPostFilingRules, type FilingRecord, type PostFilingRules } from '@taxfs/postfiling';
import { buildInputFor } from '../../forms/test/helpers';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

export const pfRules: PostFilingRules = loadPostFilingRules(
  JSON.parse(readFileSync(root('rules/fixtures/2025.POSTFILING.json'), 'utf8')),
);

export const fedRules = loadFedRules();
export const ilRules = loadIlRules();
export const fixedClock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

/** Deterministic notice "model": parses the pipe-format demo notice text. */
export function makeNoticeDeps(): AgentRunDeps {
  const stub = new StubProvider().on('stub:notice_extraction', (req) => {
    const text = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.includes('|'));
    const [header, ...itemLines] = lines;
    const [notice_type, notice_date, response_deadline] = (header ?? '').split('|');
    return JSON.stringify({
      notice_type,
      notice_date,
      response_deadline,
      items: itemLines.map((l) => {
        const [form, payer, concept, amount, claim_kind] = l.split('|');
        return { form, payer, concept, amount, claim_kind };
      }),
    });
  });
  const router = new ModelRouter(stubRouterConfig(['notice_extraction'])).registerProvider(stub);
  return { client: new LlmClient(router), log: new InMemoryAgentLog() };
}

export const CP2000_TEXT = [
  'CP2000|2026-05-15|2026-08-13',
  '1099-INT|Second Bank|income.interest|350|underreported',
  'W-2|Acme Corp|income.wages|65000|mismatch',
].join('\n');

export interface FiledRig {
  s: Scenario;
  packages: PackageStore;
  manifest: PackageManifest;
  pf: PostFilingStore;
  filing: FilingRecord;
  facts: TaxFact[];
}

export async function filedScenario(): Promise<FiledRig> {
  const s = await seedScenario(fedRules, ilRules);
  await s.orchestrator.runAll();
  const facts = await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 });
  const built = await buildPackage(
    buildInputFor('return1-single-w2', {
      taxpayer_id: 'tp-e2e',
      facts,
      gate_runs: (await s.spine.inspect()).gateRuns,
      hard_gates_passed: true,
      spine: s.spine,
    }),
  );
  const packages = new PackageStore(fixedClock);
  const manifest = packages.commit(built);
  packages.lock(manifest.package_id);
  const pf = new PostFilingStore(fixedClock);
  const filing = pf.markFiled({
    manifest: packages.get(manifest.package_id)!.manifest,
    channel: 'paper',
    filed_date: '2026-04-10',
    baseline_lines: baselineLines(facts),
  });
  return { s, packages, manifest, pf, filing, facts };
}

export function baselineLines(facts: TaxFact[]): Record<string, string> {
  return Object.fromEntries(
    facts.filter((f) => f.derivation !== undefined).map((f) => [f.concept, f.value.toString()]),
  );
}
