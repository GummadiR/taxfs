/**
 * SCREEN PARITY — the oracle this project did not have.
 *
 * TaxFS is a restart of TaxOS, a working system. Every gate in this repo
 * (lint, typecheck, build, unit, e2e) checks TaxFS against ITSELF, so a
 * screen rewritten from the data model instead of ported from TaxOS still
 * renders, still typechecks, still passes — while quietly missing what the
 * original could do. That is exactly what happened to five screens, and the
 * operator found it, not the build.
 *
 * What a test cannot see, a comparison can. This extracts each screen's
 * OPERATOR AFFORDANCES — the things a person can actually do on it:
 *
 *   - every form control (input / select / textarea) by its `name`
 *   - every button by its label
 *
 * Copy is deliberately NOT compared: rewording is legitimate, and comparing
 * prose would drown the real signal in noise. A missing control or a missing
 * button is a lost capability, and that is the whole signal.
 *
 * TaxOS lives in a separate repo that CI does not check out, so its surface
 * is EXTRACTED ONCE into scripts/taxos-screen-surface.json (UI labels only —
 * source code, never data) and committed. The normal run compares TaxFS
 * against that snapshot and needs nothing but this repo.
 *
 *   pnpm parity:screens              compare (CI; exits 1 on an unexplained gap)
 *   pnpm parity:screens --snapshot <path-to-taxos>   regenerate the snapshot
 *
 * Every gap must be listed in scripts/parity-differences.json WITH A REASON.
 * A deliberate divergence is fine — TaxFS moved identity out of the server
 * entirely, so Get Started legitimately lost those fields. An unexplained
 * one fails the build. "We rebuilt it and forgot" is not a reason anyone
 * writes down, which is the point.
 *
 * A reason may start with "TODO:" for a capability that is genuinely still
 * missing and meant to come back. Those do not fail the build — they are
 * REPORTED, by name, on every single run, so a known gap cannot quietly
 * become a forgotten one. `--strict` fails on them too, for when the aim is
 * to close them out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * TaxOS route → TaxFS route, plus any shared component whose affordances
 * belong to that screen (the lineage drawer is opened from Review, so its
 * buttons are part of what Review can do).
 */
interface ScreenMap {
  taxos: string;
  taxfs: string;
  /** Extra files, relative to each app's src/, merged into the surface. */
  taxosExtra?: string[];
  taxfsExtra?: string[];
}

const SCREENS: ScreenMap[] = [
  { taxos: 'get-started', taxfs: 'get-started' },
  { taxos: 'documents', taxfs: 'documents' },
  { taxos: 'data', taxfs: 'data' },
  { taxos: 'interview', taxfs: 'interview' },
  {
    taxos: 'review', taxfs: 'review',
    taxosExtra: ['components/lineage.tsx'], taxfsExtra: ['components/lineage.tsx'],
  },
  { taxos: 'gates', taxfs: 'gates' },
  { taxos: 'forms', taxfs: 'forms' },
  {
    taxos: 'file-it', taxfs: 'file-it',
    taxfsExtra: ['app/file-it/identity-panel.tsx'],
  },
  { taxos: 'efile', taxfs: 'efile' },
  { taxos: 'risk', taxfs: 'risk' },
  { taxos: 'amend', taxfs: 'amend' },
  { taxos: 'entities', taxfs: 'entities' },
  { taxos: 'business', taxfs: 'business' },
  { taxos: 'year-round', taxfs: 'year-round' },
];

export interface ScreenSurface {
  /** `name` of every input/select/textarea — what the operator can enter. */
  controls: string[];
  /** Label of every button — what the operator can do. */
  buttons: string[];
}

const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);
const BUTTON_TAGS = new Set(['button', 'SubmitButton']);

function tagName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return node.tagName.getText();
}

/** A string-literal attribute value, or null when it is an expression. */
function stringAttr(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attr: string,
): string | null {
  for (const p of node.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== attr) continue;
    const v = p.initializer;
    if (v && ts.isStringLiteral(v)) return v.text;
    if (v && ts.isJsxExpression(v) && v.expression && ts.isStringLiteral(v.expression)) {
      return v.expression.text;
    }
    return null; // a computed name: real, but not comparable across repos
  }
  return null;
}

/** The visible words of a button: its JSX text, whitespace-normalised. */
function buttonLabel(node: ts.JsxElement): string {
  const parts: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    n.forEachChild(walk);
  };
  node.children.forEach(walk);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Labels differ in wording between the two apps far more than they differ in
 * meaning ("Confirm this value" vs "Confirm value"). Compare on a reduced
 * form: lowercase, letters only, stop-words dropped — so rewording passes
 * and a REMOVED button does not.
 */
const STOP = new Set(['the', 'a', 'an', 'this', 'my', 'your', 'it', 'and', 'to', 'for', 'of', 'from', 'on', 'in']);
export function reduce(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .sort()
    .join(' ');
}

export function surfaceOf(sources: string[]): ScreenSurface {
  const controls = new Set<string>();
  const buttons = new Set<string>();
  for (const text of sources) {
    const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n: ts.Node): void => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        if (CONTROL_TAGS.has(tagName(n))) {
          const name = stringAttr(n, 'name');
          // A hidden input carries plumbing, not an operator affordance.
          if (name && stringAttr(n, 'type') !== 'hidden') controls.add(name);
        }
      }
      if (ts.isJsxElement(n) && BUTTON_TAGS.has(tagName(n.openingElement))) {
        const label = buttonLabel(n);
        if (label) buttons.add(label);
      }
      n.forEachChild(walk);
    };
    walk(sf);
  }
  return { controls: [...controls].sort(), buttons: [...buttons].sort() };
}

function readAll(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8'));
}

function taxfsFiles(m: ScreenMap): string[] {
  const src = join(repoRoot, 'apps/web/src');
  return [join(src, 'app', m.taxfs, 'page.tsx'), ...(m.taxfsExtra ?? []).map((f) => join(src, f))];
}

function taxosFiles(root: string, m: ScreenMap): string[] {
  const src = join(root, 'apps/web/src');
  return [join(src, 'app', m.taxos, 'page.tsx'), ...(m.taxosExtra ?? []).map((f) => join(src, f))];
}

const SNAPSHOT = join(repoRoot, 'scripts/taxos-screen-surface.json');
const DIFFERENCES = join(repoRoot, 'scripts/parity-differences.json');

interface Differences {
  [screen: string]: { controls?: Record<string, string>; buttons?: Record<string, string> };
}

function snapshot(taxosRoot: string): number {
  if (!existsSync(join(taxosRoot, 'apps/web/src/app'))) {
    console.error(`no TaxOS checkout at ${taxosRoot}`);
    return 1;
  }
  const out: Record<string, ScreenSurface> = {};
  for (const m of SCREENS) {
    const files = taxosFiles(taxosRoot, m);
    if (!existsSync(files[0]!)) {
      console.error(`  skipped ${m.taxos} — no page.tsx in the reference`);
      continue;
    }
    out[m.taxfs] = surfaceOf(readAll(files));
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(out, null, 2)}\n`);
  const screens = Object.keys(out).length;
  const controls = Object.values(out).reduce((n, s) => n + s.controls.length, 0);
  const buttons = Object.values(out).reduce((n, s) => n + s.buttons.length, 0);
  console.log(`snapshot written: ${screens} screens, ${controls} controls, ${buttons} buttons`);
  return 0;
}

function compare(): number {
  if (!existsSync(SNAPSHOT)) {
    console.error(`no snapshot at ${SNAPSHOT} — run: pnpm parity:screens --snapshot <path-to-taxos>`);
    return 1;
  }
  const reference = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, ScreenSurface>;
  const differences: Differences = existsSync(DIFFERENCES)
    ? (JSON.parse(readFileSync(DIFFERENCES, 'utf8')) as Differences)
    : {};
  const findings: string[] = [];
  const todos: string[] = [];
  const strict = process.argv.includes('--strict');
  let compared = 0;

  for (const m of SCREENS) {
    const ref = reference[m.taxfs];
    if (!ref) continue;
    const files = taxfsFiles(m);
    if (!existsSync(files[0]!)) {
      findings.push(`${m.taxfs}: the screen does not exist in TaxFS at all`);
      continue;
    }
    compared += 1;
    const mine = surfaceOf(readAll(files));
    const excused = differences[m.taxfs] ?? {};

    const record = (reason: string | undefined, gap: string): void => {
      if (reason === undefined) {
        findings.push(`${gap} — port it, or explain the difference in scripts/parity-differences.json`);
      } else if (reason.startsWith('TODO:')) {
        todos.push(`${gap}\n      ${reason.slice(5).trim()}`);
      }
    };

    for (const name of ref.controls) {
      if (mine.controls.includes(name)) continue;
      record(excused.controls?.[name], `${m.taxfs}: the operator could enter "${name}" in TaxOS and cannot here`);
    }
    const mineReduced = new Set(mine.buttons.map(reduce));
    for (const label of ref.buttons) {
      if (mineReduced.has(reduce(label))) continue;
      record(excused.buttons?.[label], `${m.taxfs}: the operator could press “${label}” in TaxOS and cannot here`);
    }
  }

  if (todos.length > 0) {
    console.log(`parity:screens — ${todos.length} KNOWN capability gap(s) vs TaxOS, still open:\n`);
    for (const t of todos) console.log('  • ' + t);
    console.log('');
  }
  if (findings.length > 0) {
    console.error(`parity:screens FAILED — ${findings.length} unexplained capability(ies) lost vs TaxOS:\n`);
    for (const f of findings) console.error('  ' + f);
    console.error('\nA screen that typechecks and passes every test can still do LESS than');
    console.error('the one it replaced. That is what this check exists to catch.');
    return 1;
  }
  if (strict && todos.length > 0) {
    console.error(`parity:screens --strict: ${todos.length} known gap(s) are still open.`);
    return 1;
  }
  console.log(`parity:screens clean — ${compared} screens, every TaxOS capability present or accounted for`);
  return 0;
}

function main(argv: string[]): number {
  const i = argv.indexOf('--snapshot');
  if (i !== -1) {
    const root = argv[i + 1];
    if (!root) {
      console.error('usage: parity:screens --snapshot <path-to-taxos-checkout>');
      return 1;
    }
    return snapshot(root);
  }
  return compare();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
