/**
 * Root .env loader. In TaxOS the app lived at the repo root, so operators
 * learned to put .env/.env.local THERE — and did the same with TaxFS (found
 * on a real machine: an ANTHROPIC_API_KEY at the root, silently ignored
 * because Next.js only reads env files from apps/web). Honor the habit:
 * KEY=VALUE lines from the repo root's .env.local and .env fill in any
 * variable the process does not already have. Precedence stays standard:
 * real environment > apps/web/.env.local (Next) > root .env.local > root .env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse KEY=VALUE lines (comments/blank lines skipped; surrounding quotes
 *  stripped). Deliberately tiny — no interpolation, no multiline. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Apply a parsed file to process.env WITHOUT overriding anything set. */
export function applyEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function repoRoot(): string {
  const here = process.cwd(); // apps/web under next dev/start; repo root in tests
  return existsSync(join(here, 'rules', 'fixtures')) ? here : join(here, '../..');
}

let loaded = false;

/** Idempotent; called from env.ts at import time so every consumer sees it. */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const name of ['.env.local', '.env']) {
    // turbopackIgnore: reading the operator's own .env at runtime must not
    // make the bundler trace (and ship) the entire project tree.
    const path = join(/* turbopackIgnore: true */ repoRoot(), name);
    try {
      if (existsSync(/* turbopackIgnore: true */ path)) {
        applyEnv(parseEnvFile(readFileSync(/* turbopackIgnore: true */ path, 'utf8')));
      }
    } catch {
      // unreadable root env file: the process env still rules
    }
  }
}
