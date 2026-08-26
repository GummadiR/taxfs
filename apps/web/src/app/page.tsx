import { WORKSPACE } from '@taxfs/shared';

export default function Home() {
  return (
    <main>
      <h1 className="text-2xl font-black tracking-tight">TaxFS</h1>
      <p className="mt-2 text-sm text-slate-600">
        Phase 1 skeleton. The gate chain — lint (incl. money-lint), typecheck,
        production build, unit, e2e against that build — is enforced before any
        feature lands.
      </p>
      <p className="mt-2 text-xs text-slate-400" data-testid="workspace-marker">
        workspace: {WORKSPACE}
      </p>
    </main>
  );
}
