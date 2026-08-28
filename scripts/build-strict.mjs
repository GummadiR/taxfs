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

// `shell` on Windows is REQUIRED, not cosmetic: pnpm is installed there as
// pnpm.cmd, which spawnSync cannot execute directly. Without it the spawn
// fails with ENOENT, status is null, stdout/stderr are empty — and the old
// code exited 1 having printed NOTHING, so the launcher's "Build failed"
// was the only clue an operator ever got. Found on a real Windows run; CI
// and every dev container are Linux, where the bare name resolves fine.
const result = spawnSync('pnpm', ['--filter', 'web', 'build'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

// The spawn itself failing is a different thing from the build failing, and
// it must never be silent (the same loud-failure rule the gate enforces for
// next build applies to this wrapper).
if (result.error) {
  console.error(`\nbuild-strict: could not run the build command (${result.error.code ?? result.error.message}).`);
  console.error('  Is pnpm installed and on PATH?  npm install -g pnpm');
  process.exit(1);
}

const output = (result.stdout ?? '') + (result.stderr ?? '');
process.stdout.write(output);

const errorLines = output.split('\n').filter((l) => /^\s*Error:/.test(l));
if (result.status !== 0) {
  if (output.trim() === '') {
    console.error(`\nbuild-strict: the build exited ${result.status ?? 'with a signal'} and printed nothing.`);
    console.error('  Send this whole window to Claude — a silent build failure is itself the bug.');
  }
  process.exit(result.status ?? 1);
}
if (errorLines.length > 0) {
  console.error('\nbuild-strict: next build exited 0 but printed error(s) — failing the gate (P86 class):');
  for (const l of errorLines) console.error('  ' + l.trim());
  process.exit(1);
}
