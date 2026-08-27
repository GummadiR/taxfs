/** Agents test rig: stub-provider router + rule-data fixture loaders. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InMemoryAgentLog,
  LlmClient,
  ModelRouter,
  StubProvider,
  stubRouterConfig,
  type AgentRunDeps,
  type StubHandler,
} from '@taxfs/shared';
import { loadAuthorityStore, loadQuestionTemplates, type AuthorityStore, type QuestionTemplate } from '@taxfs/agents';

// The §6 roster: extraction (+ the simple-tier route), interview,
// explanation, discovery. Categorization and audit-summary are dropped.
export const AGENT_IDS = ['extraction', 'extraction_simple', 'interview', 'explanation', 'discovery'];

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

export function loadTemplates(): QuestionTemplate[] {
  return loadQuestionTemplates(JSON.parse(readFileSync(root('rules/fixtures/2025.QUESTIONS.json'), 'utf8')));
}

export function loadAuthority(): AuthorityStore {
  return loadAuthorityStore(JSON.parse(readFileSync(root('rules/fixtures/2025.AUTHORITY.json'), 'utf8')));
}

export interface AgentRig {
  deps: AgentRunDeps;
  stub: StubProvider;
  log: InMemoryAgentLog;
}

/** Router config points every agent at the deterministic stub provider. */
export function makeRig(handlers: Record<string, StubHandler>): AgentRig {
  const stub = new StubProvider();
  for (const [agentId, handler] of Object.entries(handlers)) {
    stub.on(`stub:${agentId}`, handler);
  }
  const router = new ModelRouter(stubRouterConfig(AGENT_IDS)).registerProvider(stub);
  const log = new InMemoryAgentLog();
  return { deps: { client: new LlmClient(router), log }, stub, log };
}

/** The user-message payload the stub "model" sees (for input-aware fixtures). */
export function userContent(req: { messages: { role: string; content: string }[] }): string {
  return req.messages.find((m) => m.role === 'user')?.content ?? '';
}
