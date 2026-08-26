/**
 * Guardrail G4 (Blueprint §9): no hardcoded dollar figure and no hardcoded
 * company/person name in kernel or critic source. Tax figures live only in
 * cited, year-versioned rule data (N2); entities are always data (N10).
 *
 * Two passes over each file in the money scopes:
 *  1. CODE literals — a character-level scanner strips comments and blanks
 *     string/template contents (the kernels build multi-line explanation
 *     strings full of form numbers like "1040 line 11"; prose is not money),
 *     then any bare numeric literal >= 50 fails.
 *  2. MONEY literals — Money values travel as quoted strings by design, so
 *     pass 1 alone would miss `Money.fromString('200')`. This pass scans the
 *     comment-stripped source for quoted numeric arguments to the Money
 *     constructors/operators and fails on any >= 50.
 * A line may carry `// audit-allow: <reason>` for a reviewed exception; the
 * reason is mandatory. A configurable entity-name denylist
 * (scripts/audit-entities.json, synthetic names only) fails on any hit in
 * packages/. Exit 1 on any finding; CI runs this on every push.
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const MONEY_SCOPES = [
  'packages/kernel/src',
  'packages/kernel2/src',
  'packages/gates/src/critics',
];

const NUMERIC_FLOOR = 50;
const NUMBER_RE = /(?<![\w.§])(\d{1,3}(?:_\d{3})*|\d+)(\.\d+)?(?![\w.])/g;
const MONEY_ARG_RE = /(?:Money\.fromString|(?<![\w.])D)\(\s*'(-?[\d_]+(?:\.\d+)?)'|\.(?:mulRate|mulFraction)\(\s*'(-?[\d_]+(?:\.\d+)?)'(?:\s*,\s*'(-?[\d_]+(?:\.\d+)?)')?/g;
const ALLOW_RE = /\/\/\s*audit-allow:\s*\S+/;

/**
 * Character-level scan producing two views of the source, both line-aligned
 * with the original:
 *  - codeOnly: comments removed AND string/template contents blanked
 *  - noComments: comments removed, strings kept
 * Handles '', "", ``, escapes, and multi-line template literals. Template
 * interpolations are treated as string content in codeOnly (pass 2 still
 * sees them via noComments).
 */
export function stripViews(source: string): { codeOnly: string[]; noComments: string[] } {
  let code = '';
  let noC = '';
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  for (let i = 0; i < source.length; i = i + 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line-comment'; code += ' '; noC += ' '; i = i + 1; code += ' '; noC += ' '; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; code += ' '; noC += ' '; i = i + 1; code += ' '; noC += ' '; continue; }
      if (ch === "'") { mode = 'single'; code += ch; noC += ch; continue; }
      if (ch === '"') { mode = 'double'; code += ch; noC += ch; continue; }
      if (ch === '`') { mode = 'template'; code += ch; noC += ch; continue; }
      code += ch; noC += ch; continue;
    }
    if (mode === 'line-comment') {
      if (ch === '\n') { mode = 'code'; code += ch; noC += ch; } else { code += ' '; noC += ' '; }
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; code += '  '; noC += '  '; i = i + 1; }
      else { code += ch === '\n' ? '\n' : ' '; noC += ch === '\n' ? '\n' : ' '; }
      continue;
    }
    // string modes: keep newlines for line alignment; blank content in codeOnly
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (ch === '\\') { code += '  '; noC += '\\' + (next ?? ''); i = i + 1; continue; }
    if (ch === closer) { mode = 'code'; code += ch; noC += ch; continue; }
    code += ch === '\n' ? '\n' : ' ';
    noC += ch;
  }
  return { codeOnly: code.split('\n'), noComments: noC.split('\n') };
}

export function auditFile(path: string, source: string): string[] {
  const findings: string[] = [];
  const raw = source.split('\n');
  const { codeOnly, noComments } = stripViews(source);
  const flag = (i: number, text: string, kind: string): void => {
    findings.push(`${path}:${i + 1} ${kind} ${text} (>= ${NUMERIC_FLOOR}) — tax figures belong in rule data (G4)`);
  };
  codeOnly.forEach((line, i) => {
    if (ALLOW_RE.test(raw[i] ?? '')) return;
    for (const m of line.matchAll(NUMBER_RE)) {
      const value = Number((m[1] ?? '').replaceAll('_', '') + (m[2] ?? ''));
      if (Math.abs(value) >= NUMERIC_FLOOR) flag(i, `numeric literal ${m[0]}`, 'code');
    }
  });
  noComments.forEach((line, i) => {
    if (ALLOW_RE.test(raw[i] ?? '')) return;
    for (const m of line.matchAll(MONEY_ARG_RE)) {
      for (const g of [m[1], m[2], m[3]]) {
        if (g === undefined) continue;
        const value = Number(g.replaceAll('_', ''));
        if (Math.abs(value) >= NUMERIC_FLOOR) flag(i, `Money literal '${g}'`, 'money');
      }
    }
  });
  return findings;
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    const st = lstatSync(p);            // never follow symlinks (pnpm links cycle)
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) yield p;
  }
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
