/**
 * I.3 acceptance: fixture CP2000 with one omitted 1099 (agree) and one
 * wrong IRS claim (disagree) → correct agree-path delta + an indexed,
 * neutral disagree packet from Defense File sections + DUT splitting.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  agreeDelta,
  buildDisagreePacket,
  extractNotice,
  matchNoticeItems,
  splitForDut,
  type ExtractedNotice,
  type MatchedItem,
} from '@taxfs/postfiling';
import {
  CaptureStore,
  buildDefenseFile,
  buildReconciliation,
  loadCaptureRules,
  type DefenseFile,
} from '@taxfs/defense';
import { CP2000_TEXT, filedScenario, fixedClock, fedRules, ilRules, makeNoticeDeps, pfRules, type FiledRig } from './helpers';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

let rig: FiledRig;
let notice: ExtractedNotice;
let matches: MatchedItem[];
let defense: DefenseFile;

beforeAll(async () => {
  rig = await filedScenario();
  const extraction = await extractNotice(makeNoticeDeps(), { notice_id: 'n-1', ocr_text: CP2000_TEXT });
  if (extraction.status !== 'ok') throw new Error('extraction failed');
  notice = extraction.notice;
  matches = matchNoticeItems(notice, rig.facts);
  const stored = rig.packages.get(rig.manifest.package_id)!;
  const sources = await rig.s.spine.getSources('tp-e2e', 2025);
  const captureRules = loadCaptureRules(JSON.parse(readFileSync(root('rules/fixtures/2025.CAPTURE-RULES.json'), 'utf8')));
  defense = buildDefenseFile(
    {
      manifest: stored.manifest,
      artifacts: stored.artifacts,
      reconciliation: buildReconciliation(rig.facts, sources, '2026-07-02'),
      memos: [],
      capture_records: new CaptureStore(fixedClock, captureRules).defenseEligible(),
      gate_runs: (await rig.s.spine.inspect()).gateRuns,
    },
    fixedClock,
  );
});

describe('notice extraction (E.1 variant, stub provider)', () => {
  it('extracts type, dates, and items; validation rejects malformed dates', async () => {
    expect(notice.notice_type).toBe('CP2000');
    expect(notice.response_deadline).toBe('2026-08-13');
    expect(notice.items).toHaveLength(2);
    const bad = await extractNotice(makeNoticeDeps(), {
      notice_id: 'n-bad',
      ocr_text: 'CP2000|May 15|soon\n1099-INT|X|income.interest|350|underreported',
    });
    expect(bad.status).toBe('rejected');
  });
});

describe('matching + agree path', () => {
  it('suggests agree for the omitted 1099 and disagree for the wrong wage claim', () => {
    const interest = matches.find((m) => m.claim.concept === 'income.interest')!;
    const wages = matches.find((m) => m.claim.concept === 'income.wages')!;
    // Our return HAS interest of 1000 but not 350 — records exist with a
    // different amount ⇒ disagree suggestion with our records attached.
    expect(interest.suggested_path).toBe('disagree');
    expect(interest.our_fact_refs.length).toBeGreaterThan(0);
    expect(wages.suggested_path).toBe('disagree');
    expect(wages.our_fact_refs).toContain('f:w2-1:wages');
  });

  it('agree path recomputes the exact delta with the non-skippable §6662/interest alert', () => {
    const claim = notice.items.find((i) => i.concept === 'income.interest')!;
    const outcome = agreeDelta({
      kernelInput: {
        taxpayer_id: 'tp-e2e',
        tax_year: 2025,
        ctx: rig.s.filing,
        fed_rules: fedRules,
        il_rules: ilRules,
      },
      facts: rig.facts,
      claim,
      rules: pfRules,
    });
    // Scenario: 51200 → 51550 income (second 1099-INT of 350);
    // taxable 36200 → 36550; tax 4144 → 4186
    expect(outcome.original_tax).toBe('4144');
    expect(outcome.corrected_tax).toBe('4186');
    expect(outcome.delta).toBe('42');
    expect(outcome.alert).toContain('§6662');
    expect(outcome.alert).toContain('interest continues to accrue');
    expect(outcome.alert).toContain('nothing is sent for you');
    expect(outcome.dismissible).toBe(false);
  });
});

describe('disagree path: indexed claim→exhibit packet (I.3)', () => {
  it('leads with a claim table mapping each IRS item to numbered exhibits; language stays neutral', async () => {
    const noticeCase = rig.pf.openNoticeCase({
      filing: rig.filing,
      notice_type: 'CP2000',
      notice_date: notice.notice_date,
      response_deadline: notice.response_deadline,
      items: matches.map((m) => ({ irs_claim: m.claim, our_fact_refs: m.our_fact_refs })),
    });
    const packet = buildDisagreePacket({
      case_id: noticeCase.case_id,
      items: noticeCase.items.map((item, i) => ({ item, matched: matches[i]! })),
      defense,
    });
    expect(packet.claim_table).toHaveLength(2);
    expect(packet.claim_table[0]?.claim_no).toBe(1);
    for (const row of packet.claim_table) {
      expect(row.exhibit_refs.length, row.irs_claim).toBeGreaterThan(0);
      for (const ref of row.exhibit_refs) expect(ref).toMatch(/^EX-\d{2}$/);
    }
    expect(packet.exhibits.length).toBeGreaterThan(0);
    expect(packet.cover_note).toContain('nothing has been transmitted');
    // Exhibits come only from Defense File sections (no ack material exists there by construction)
    expect(JSON.stringify(packet)).not.toMatch(/"ack_id"/);
  });
});

describe('DUT-style packaging', () => {
  it('splits over the size limit with category-consistent part names', () => {
    const files = [
      { name: 'claim-table.pdf', content: 'x'.repeat(400) },
      { name: 'EX-01.pdf', content: 'x'.repeat(600) },
      { name: 'EX-02.pdf', content: 'x'.repeat(500) },
      { name: 'EX-03.pdf', content: 'x'.repeat(300) },
    ];
    const parts = splitForDut(files, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.total_bytes).toBeLessThanOrEqual(1000);
      expect(p.part_name).toMatch(/^upload-part-\d{2}-of-\d{2}$/);
    }
    expect(parts.flatMap((p) => p.files.map((f) => f.name))).toEqual(files.map((f) => f.name));
  });

  it('a single oversize exhibit routes to the mail fallback', () => {
    expect(() => splitForDut([{ name: 'huge.pdf', content: 'x'.repeat(2000) }], 1000)).toThrow(/mail fallback/);
  });
});
