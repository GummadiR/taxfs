/**
 * ORIGIN: AHC (SCP repo) §4 — model router.
 * Clean-room TS implementation per spec E.0 (see provider.ts header for the
 * shared-import caveat). Swapping vendors touches THIS config, not agents.
 */
import type { LlmProvider } from './provider';

export interface RouteConfig {
  provider: string;
  model: string;
  /** E.0: temp=0 where supported — enforced by LlmClient at call time. */
  temperature: number;
  max_retries: number;
}

export interface RouterConfig {
  routes: Record<string, RouteConfig>;
}

export class ModelRouter {
  private readonly providers = new Map<string, LlmProvider>();

  constructor(private readonly config: RouterConfig) {}

  registerProvider(p: LlmProvider): this {
    this.providers.set(p.provider_id, p);
    return this;
  }

  resolve(agent_id: string): { provider: LlmProvider; route: RouteConfig } {
    const route = this.config.routes[agent_id];
    if (!route) throw new Error(`ModelRouter: no route configured for agent "${agent_id}"`);
    const provider = this.providers.get(route.provider);
    if (!provider) {
      throw new Error(`ModelRouter: provider "${route.provider}" not registered (agent "${agent_id}")`);
    }
    if (provider.supports_temperature && route.temperature !== 0) {
      throw new Error(
        `ModelRouter: agent "${agent_id}" routes to a temperature-capable provider with temperature ${route.temperature} — E.0 requires temp=0 where supported`,
      );
    }
    return { provider, route };
  }
}

/** Default step-1 routing: every agent → deterministic stub. */
export function stubRouterConfig(agentIds: string[]): RouterConfig {
  const routes: Record<string, RouteConfig> = {};
  for (const id of agentIds) {
    routes[id] = { provider: 'stub', model: `stub:${id}`, temperature: 0, max_retries: 2 };
  }
  return { routes };
}
