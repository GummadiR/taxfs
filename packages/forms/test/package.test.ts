/**
 * D.3/D.4/D.5 unit coverage: XML byte-stability + round-trip, stub-schema
 * validation pipeline, business rules, and lock/unlock/version mechanics.
 */
import { describe, expect, it } from 'vitest';
import { Money } from '@taxfs/shared';
import {
  PackageStore,
  StubSchemaValidator,
  parseXml,
  roundTripDiff,
  runBusinessRules,
  type FormInstance,
} from '@taxfs/forms';
import { bizRules, buildFor, fixedClock, stubFed } from './helpers.js';

describe('XML generation + round-trip (D.4.3)', () => {
  it('is byte-stable: identical inputs ⇒ identical bytes', async () => {
    const a = await buildFor('return3-mfj-multidoc');
    const b = await buildFor('return3-mfj-multidoc');
    const xml = (built: typeof a, jur: string) =>
      built.artifacts.find((x) => x.target === 'mef_xml' && x.jurisdiction === jur)!.content;
    expect(xml(a, 'FED')).toBe(xml(b, 'FED'));
    expect(xml(a, 'IL')).toBe(xml(b, 'IL'));
  });

  it('round-trips clean on a real build, and catches a tampered serialization', async () => {
    const built = await buildFor('return2-w2-1099int');
    expect(built.report.round_trip_mismatches).toEqual([]);
    const fedXml = built.artifacts.find((a) => a.artifact_id === 'xml:FED')!.content;
    const tampered = fedXml.replace('<TaxAmt>4144</TaxAmt>', '<TaxAmt>4143</TaxAmt>');
    const fedInstances = built.instances.filter((i) => i.jurisdiction === 'FED');
    const diffs = roundTripDiff(tampered, (await import('./helpers.js')).fedRelease.forms, fedInstances);
    expect(diffs).toEqual([{ form_id: '1040', line_id: '1040.16', expected: '4144', parsed: '4143' }]);
  });

  it('parses its own output shape', async () => {
    const built = await buildFor('return1-single-w2');
    const root = parseXml(built.artifacts.find((a) => a.artifact_id === 'xml:FED')!.content);
    expect(root.name).toBe('TaxOSReturn');
    expect(root.children.map((c) => c.name)).toEqual(['ReturnHeader', 'ReturnData']);
  });
});

describe('stub schema validation (D.4.1 — real XSDs drop in behind the same interface)', () => {
  it('clean build validates', async () => {
    const built = await buildFor('return3-mfj-multidoc');
    expect(built.report.schema_violations).toEqual([]);
  });

  it('flags unknown elements and non-integer money values', async () => {
    const built = await buildFor('return1-single-w2');
    const validator = new StubSchemaValidator(stubFed);
    const { fedRelease } = await import('./helpers.js');
    const fedXml = built.artifacts.find((a) => a.artifact_id === 'xml:FED')!.content;
    const unknownEl = fedXml.replace('<TaxAmt>5700</TaxAmt>', '<HackedAmt>5700</HackedAmt>');
    expect(validator.validate(unknownEl, fedRelease.forms).some((v) => v.message.includes('not in schema'))).toBe(true);
    const fractional = fedXml.replace('<TaxAmt>5700</TaxAmt>', '<TaxAmt>5700.25</TaxAmt>');
    expect(validator.validate(fractional, fedRelease.forms).some((v) => v.message.includes('money pattern'))).toBe(true);
    const missingRequired = fedXml.replace(/<TaxAmt>5700<\/TaxAmt>\n/, '');
    expect(validator.validate(missingRequired, fedRelease.forms).some((v) => v.message.includes('required element missing'))).toBe(true);
  });
});

describe('business rules from rule-data (D.4.2)', () => {
  it('flags a refund and balance-due populated together', () => {
    const impossible: FormInstance = {
      instance_id: 'fi:2025:1040',
      form_id: '1040',
      revision: 'r',
      jurisdiction: 'FED',
      tax_year: 2025,
      taxpayer_id: 'tp',
      values: { '1040.34': Money.fromString('100'), '1040.37': Money.fromString('50') },
      lineage: {},
      status: 'draft',
    };
    const errors = runBusinessRules(bizRules, [impossible]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.rule_id).toMatch(/FED-REJ-REFUND-XOR-OWE/);
  });
});

describe('lock / unlock / versioning (D.5)', () => {
  it('locks only clean packages; locked manifests are immutable; unlock → v2 with history', async () => {
    const store = new PackageStore(fixedClock);
    const v1built = await buildFor('return2-w2-1099int');
    expect(v1built.report.clean).toBe(true);
    const v1 = store.commit(v1built);
    expect(v1.version).toBe(1);
    store.lock(v1.package_id);

    // Immutable once locked
    expect(() => {
      (store.get(v1.package_id)!.manifest as { status: string }).status = 'draft';
    }).toThrow();

    // Post-lock rebuild without unlock is refused
    await expect((async () => store.commit(await buildFor('return2-w2-1099int')))()).rejects.toThrow(/LOCKED/);

    // Explicit unlock → next commit is v2, supersedes v1, unlock recorded
    store.unlock(v1.package_id, 'corrected 1099-INT received');
    const v2 = store.commit(await buildFor('return2-w2-1099int'));
    expect(v2.version).toBe(2);
    expect(v2.supersedes).toBe(v1.package_id);
    expect(v2.unlock_history).toHaveLength(1);
    expect(v2.unlock_history[0]?.reason).toMatch(/corrected 1099/);

    // Version history retained; v1 unchanged
    const history = store.history('tp-golden', 2025);
    expect(history.map((m) => m.version)).toEqual([1, 2]);
    expect(history[0]?.status).toBe('locked');
    // Runtime-state archival: frozen refs present
    expect(v1.rule_versions.FED).toMatch(/PLACEHOLDER/);
    expect(v1.form_def_releases.FED).toMatch(/FORMS\.FED/);
    expect(v1.kernel_version).toMatch(/kernel-/);
    expect(v1.form_def_versions['1040']).toMatch(/1040-2025/);
  });

  it('refuses to lock a dirty package (no "fix later" shipping — D.8)', async () => {
    const store = new PackageStore(fixedClock);
    const dirty = await buildFor('return2-w2-1099int', { hard_gates_passed: false });
    expect(dirty.report.clean).toBe(false);
    const draft = store.commit(dirty);
    expect(() => store.lock(draft.package_id)).toThrow(/validation not clean/);
  });
});

describe('discardDrafts — the delete-document cleanup contract (P59)', () => {
  // When a document is deleted, deleteSelectedUploads calls discardDrafts and
  // then deletes the storage object for every id it returns. This is the ONLY
  // thing that keeps a draft package snapshot from outliving the return it was
  // built from. These tests pin the two halves of that contract: drafts are
  // dropped AND reported (so their bucket files get removed), locked versions
  // are never touched (they are the filing artifact of record).
  it('drops draft versions, returns their ids, and leaves history empty', async () => {
    const store = new PackageStore(fixedClock);
    const d1 = store.commit(await buildFor('return2-w2-1099int'));
    expect(store.history('tp-golden', 2025).map((m) => m.status)).toEqual(['draft']);

    const dropped = store.discardDrafts('tp-golden', 2025);
    expect(dropped).toEqual([d1.package_id]);
    // The caller uses exactly these ids to delete packages/<tenant>/<year>/<id>.json
    expect(store.history('tp-golden', 2025)).toEqual([]);
    expect(store.get(d1.package_id)).toBeUndefined();
  });

  it('never drops a locked version, and reports nothing to clean up', async () => {
    const store = new PackageStore(fixedClock);
    const v1 = store.commit(await buildFor('return2-w2-1099int'));
    store.lock(v1.package_id);

    const dropped = store.discardDrafts('tp-golden', 2025);
    expect(dropped).toEqual([]);
    expect(store.history('tp-golden', 2025).map((m) => m.status)).toEqual(['locked']);
    // editingBlocked is what stops a document delete while a locked package
    // stands — so documents can never be removed out from under a filed return.
    expect(store.editingBlocked('tp-golden', 2025)).toBe(true);
  });

  it('drops only the trailing draft when a locked version precedes it', async () => {
    const store = new PackageStore(fixedClock);
    const v1 = store.commit(await buildFor('return2-w2-1099int'));
    store.lock(v1.package_id);
    store.unlock(v1.package_id, 'corrected 1099-INT received');
    const v2 = store.commit(await buildFor('return2-w2-1099int'));
    expect(v2.status).toBe('draft');

    const dropped = store.discardDrafts('tp-golden', 2025);
    expect(dropped).toEqual([v2.package_id]);
    // The locked v1 survives; only the draft snapshot is cleaned from storage.
    expect(store.history('tp-golden', 2025).map((m) => m.version)).toEqual([1]);
    expect(store.get(v1.package_id)).toBeDefined();
  });
});

describe('P90 — a rebuild replaces the stale draft, never stacks beside it', () => {
  // buildAndLock discards drafts before every commit, so the version table
  // shows at most one draft. These pin the numbering: replacement keeps the
  // version NUMBER (it is the same logical version, rebuilt), while the
  // package id moves on (it is a different build).
  it('discard+commit keeps version 1 with a fresh package id', async () => {
    const store = new PackageStore(fixedClock);
    const dirty = await buildFor('return2-w2-1099int', { hard_gates_passed: false });
    const first = store.commit(dirty);
    expect(first.version).toBe(1);

    for (const id of store.discardDrafts('tp-golden', 2025)) expect(id).toBe(first.package_id);
    const second = store.commit(await buildFor('return2-w2-1099int', { hard_gates_passed: false }));

    expect(second.version).toBe(1);
    expect(second.package_id).not.toBe(first.package_id);
    expect(store.history('tp-golden', 2025).map((m) => m.package_id)).toEqual([second.package_id]);
  });

  it('after an unlock, the rebuilt draft is still v2 over the locked v1', async () => {
    const store = new PackageStore(fixedClock);
    const v1 = store.commit(await buildFor('return2-w2-1099int'));
    store.lock(v1.package_id);
    store.unlock(v1.package_id, 'corrected 1099-INT received');
    const draftA = store.commit(await buildFor('return2-w2-1099int', { hard_gates_passed: false }));
    expect(draftA.version).toBe(2);

    store.discardDrafts('tp-golden', 2025);
    const draftB = store.commit(await buildFor('return2-w2-1099int', { hard_gates_passed: false }));

    expect(draftB.version).toBe(2);
    expect(draftB.supersedes).toBe(v1.package_id);
    expect(store.history('tp-golden', 2025).map((m) => m.version)).toEqual([1, 2]);
  });
});
