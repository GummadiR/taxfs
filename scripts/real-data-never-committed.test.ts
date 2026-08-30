/**
 * REAL TAX DATA CANNOT BE COMMITTED (§9.1 negative test).
 *
 * This repository is PUBLIC. The benchmark harness ships a committed
 * template whose own instructions tell the operator to copy it to
 * `2025.REAL.return1.json` and fill in every figure from their
 * professionally-prepared return. TaxOS gitignored that filename. This repo
 * did not — so following the template's instructions would have published a
 * complete tax return, and the instructions were the trap.
 *
 * These tests attempt the forbidden thing and pass only on refusal: they
 * create real-looking benchmark files and assert git REFUSES to see them,
 * while the template stays visible. Deleting the .gitignore rule turns this
 * red.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const benchDir = join(repoRoot, 'rules', 'fixtures', 'benchmark-returns');

/** True when git would ignore the path (i.e. it can never be committed). */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: repoRoot });
    return true;
  } catch {
    return false; // exit 1 = NOT ignored
  }
}

const made: string[] = [];
function make(name: string): string {
  const abs = join(benchDir, name);
  writeFileSync(abs, '{"expected_lines":{"fed.agi":"367696"}}');
  made.push(abs);
  return `rules/fixtures/benchmark-returns/${name}`;
}

afterEach(() => {
  for (const f of made.splice(0)) rmSync(f, { force: true });
});

describe('a real benchmark return can never reach the public repo', () => {
  it('REFUSES to track the exact filename the template tells you to create', () => {
    expect(isIgnored(make('2025.REAL.return1.json'))).toBe(true);
  });

  it('REFUSES it for a future season too — no one has to remember a new line', () => {
    for (const year of ['2026', '2027', '2030']) {
      expect(isIgnored(make(`${year}.REAL.return1.json`)), year).toBe(true);
    }
  });

  it('REFUSES additional real returns, not just the first', () => {
    expect(isIgnored(make('2025.REAL.return2.json'))).toBe(true);
    expect(isIgnored(make('2025.REAL.spouse.json'))).toBe(true);
  });

  it('still TRACKS the template — the guard must not hide the instructions', () => {
    // The template is synthetic and has to stay committed, or the harness
    // loses the thing that tells an operator how to use it.
    expect(isIgnored('rules/fixtures/benchmark-returns/2025.REAL.return1.template.json')).toBe(false);
  });

  it('no real benchmark return is tracked right now', () => {
    const tracked = execFileSync('git', ['ls-files', 'rules/fixtures/benchmark-returns/'], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    const real = tracked.filter((f) => /REAL/.test(f) && !f.endsWith('.template.json'));
    expect(real, `tracked real-data files: ${real.join(', ')}`).toEqual([]);
  });

  it('the operator name lists for the masker are ignored under BOTH project names', () => {
    for (const f of ['.taxos-mask.json', '.taxfs-mask.json']) {
      writeFileSync(join(repoRoot, f), '["a name"]');
      made.push(join(repoRoot, f));
      expect(isIgnored(f), f).toBe(true);
    }
  });
});
