/** Runs the standard scenario and one agent call so all four trace kinds exist. */
import { InMemoryAgentLog } from '@taxfs/shared';
import { seedScenario, type Scenario } from '@taxfs/gates';
import { runExtraction } from '@taxfs/agents';
import { CANARY_DOCS, makeCanaryDeps } from '@taxfs/compliance';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers';

export { seedScenario };

export async function runGates(): Promise<{ s: Scenario; agentLog: InMemoryAgentLog }> {
  const s = await seedScenario(loadFedRules(), loadIlRules());
  await s.orchestrator.runAll();
  const deps = makeCanaryDeps();
  await runExtraction(deps, CANARY_DOCS[0]!, 'obs-test');
  return { s, agentLog: deps.log as InMemoryAgentLog };
}
