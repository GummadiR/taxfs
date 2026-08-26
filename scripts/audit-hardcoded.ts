/**
 * Guardrail G4 (Blueprint §9): no hardcoded dollar figure and no hardcoded
 * company/person name in kernel or critic source. Tax figures live only in
 * cited, year-versioned rule data (N2); entities are always data (N10).
 *
 * Mechanics:
 *  - Scans the money-safety scopes (kernel, kernel2, gates/critics).
 *  - Any numeric literal with absolute value >= 50 fails — real tax
 *    parameters (caps, thresholds, brackets, phase-outs) are all >= 50,
 *    while structural constants (indices, percents-as-ratios, small counts)
 *    stay below it. A line may carry `// audit-allow: <reason>` for a
 *    reviewed exception; the reason is mandatory.
 *  - A configurable entity-name denylist (scripts/audit-entities.json,
 *    synthetic names only) fails on any hit anywhere in packages/.
 *
 * Exit code 1 on any finding; CI runs this on every push.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const MONEY_SCOPES = [
  'packages/kernel/src',
  'packages/kernel2/src',
  'packages/gates/src/critics',
];

const NUMERIC_FLOOR = 50;
const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:_\d{3})*|\d+)(\.\d+)?(?![\w.])/g;
const ALLOW_RE = /\/\/\s*audit-allow:\s*\S+/;

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) yield p;
  }
}

export function auditFile(path: string, source: string): string[] {
  const findings: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (ALLOW_RE.test(line)) return;
    // Strip line comments so prose like "the $3,000 cap" in a comment
    // doesn't fire; the ban is on CODE literals.
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(NUMBER_RE)) {
      const value = Number((m[1] ?? '').replaceAll('_', '') + (m[2] ?? ''));
      if (Math.abs(value) >= NUMERIC_FLOOR) {
        findings.push(`${path}:${i + 1} numeric literal ${m[0]} (>= ${NUMERIC_FLOOR}) — tax figures belong in rule data (G4)`);
      }
    }
  });
  return findings;
}

function main(): number {
  const findings: string[] = [];
  for (const scope of MONEY_SCOPES) {
    for (const file of walk(join(repoRoot, scope))) {
      const rel = relative(repoRoot, file);
      findings.push(...auditFile(rel, readFileSync(file, 'utf8')));
    }
  }
  const denylistPath = join(repoRoot, 'scripts/audit-entities.json');
  if (existsSync(denylistPath)) {
    const names: string[] = JSON.parse(readFileSync(denylistPath, 'utf8'));
    for (const file of walk(join(repoRoot, 'packages'))) {
      const rel = relative(repoRoot, file);
      const source = readFileSync(file, 'utf8');
      for (const name of names) {
        if (name && source.includes(name)) {
          findings.push(`${rel}: contains denylisted entity name — entities are data, never code (N10)`);
        }
      }
    }
  }
  if (findings.length > 0) {
    console.error(`audit:values FAILED — ${findings.length} finding(s):`);
    for (const f of findings) console.error('  ' + f);
    return 1;
  }
  console.log('audit:values clean (kernel/kernel2/critic scopes)');
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
