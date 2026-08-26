/** P0: MeF schema catalog — stub-vs-real mode resolution. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSchemaCatalog, schemaDirFor } from '../src/schema-catalog';

describe('schema catalog (Gate 10 mode)', () => {
  it('reports stub mode when no XSDs are vendored (current honest state)', () => {
    const root = mkdtempSync(join(tmpdir(), 'taxos-schemas-'));
    const entry = resolveSchemaCatalog(root, 2025, 'FED');
    expect(entry.mode).toBe('stub');
    expect(entry.schema_dir).toBeNull();
    expect(entry.xsd_files).toEqual([]);
  });

  it('an empty vendor directory is still stub mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'taxos-schemas-'));
    mkdirSync(schemaDirFor(root, 2025, 'FED'), { recursive: true });
    expect(resolveSchemaCatalog(root, 2025, 'FED').mode).toBe('stub');
  });

  it('switches to real mode when .xsd files are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'taxos-schemas-'));
    const dir = schemaDirFor(root, 2025, 'IL');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'IL-1040.xsd'), '<xs:schema/>');
    const entry = resolveSchemaCatalog(root, 2025, 'IL');
    expect(entry.mode).toBe('real');
    expect(entry.schema_dir).toBe(dir);
    expect(entry.xsd_files).toEqual(['IL-1040.xsd']);
  });
});
