/**
 * Guardrail G5 hardening, found during the Phase-1 break proofs:
 * `next build` (16.3.2 + Tailwind v4) PRINTS
 *   "Error: Cannot apply unknown utility class ..."
 * for a broken stylesheet but still exits 0 — the exact P86 class the
 * production-build gate exists to catch. This wrapper fails the build gate
 * whenever the build output contains an Error line, restoring N7's meaning.
 * (The e2e styles-applied assertion remains as the second, independent wall.)
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['--filter', 'web', 'build'], { encoding: 'utf8' });
const output = (result.stdout ?? '') + (result.stderr ?? '');
process.stdout.write(output);

const errorLines = output.split('\n').filter((l) => /^\s*Error:/.test(l));
if (result.status !== 0) process.exit(result.status ?? 1);
if (errorLines.length > 0) {
  console.error('\nbuild-strict: next build exited 0 but printed error(s) — failing the gate (P86 class):');
  for (const l of errorLines) console.error('  ' + l.trim());
  process.exit(1);
}
