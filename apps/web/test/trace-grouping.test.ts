/**
 * A re-scanned document is ONE thing read, not three model calls.
 *
 * The AI-activity screen showed one row per call keyed on an input hash, so
 * a document scanned once and re-scanned twice filled three rows carrying
 * the same opaque hex string. The operator asked what the repeated hash
 * meant — which is the right question, because it means something specific:
 * a re-scan reuses the document's own id and stored file, so its prompt is
 * byte-identical and lands on the same hash.
 *
 * The value hiding behind that repetition is whether the reads AGREED. The
 * sink stores an output hash beside every call, so equal output hashes mean
 * the re-scan changed nothing and different ones mean the same paper was
 * read two ways — the one case where the operator should check the values
 * against the document before confirming them.
 */
import { describe, expect, it } from 'vitest';
import { groupTraces, type TraceRow } from '../src/server/agent-log';

const row = (o: Partial<TraceRow> & { trace_id: string; ts: string }): TraceRow => ({
  agent: 'extraction',
  model: 'anthropic:claude-x',
  input_hash: '00f964ea66bf02ae',
  validation: 'accepted',
  detail: { output_hash: 'aaaa', issues: [] },
  ...o,
});

describe('groupTraces', () => {
  it('collapses a document read three times into one row that says 3x', () => {
    // listTraces returns newest first; the grouping must not depend on that.
    const groups = groupTraces([
      row({ trace_id: 't3', ts: '2026-08-30T12:00:00.000Z' }),
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z' }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls).toBe(3);
    expect(groups[0]!.first).toBe('2026-08-30T10:00:00.000Z');
    expect(groups[0]!.last).toBe('2026-08-30T12:00:00.000Z');
  });

  it('says every read agreed when the answers were identical', () => {
    const groups = groupTraces([
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z', detail: { output_hash: 'aaaa', issues: [] } }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', detail: { output_hash: 'aaaa', issues: [] } }),
    ]);
    expect(groups[0]!.answers).toBe(1);
  });

  it('flags a re-scan that came back with a DIFFERENT answer', () => {
    const groups = groupTraces([
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z', detail: { output_hash: 'bbbb', issues: [] } }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', detail: { output_hash: 'aaaa', issues: [] } }),
    ]);
    expect(groups[0]!.calls).toBe(2);
    expect(groups[0]!.answers).toBe(2);
  });

  it('keeps two different documents apart even under the same agent', () => {
    const groups = groupTraces([
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z', input_hash: 'ffff0000ffff0000' }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', input_hash: '00f964ea66bf02ae' }),
    ]);
    expect(groups).toHaveLength(2);
    // Most recently read first.
    expect(groups[0]!.input_hash).toBe('ffff0000ffff0000');
  });

  it('keeps the same input under two different agents apart', () => {
    const groups = groupTraces([
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z', agent: 'discovery' }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', agent: 'extraction' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('carries the rejection and its reasons, so a discarded answer is visible', () => {
    const groups = groupTraces([
      row({
        trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', validation: 'rejected',
        detail: { output_hash: 'aaaa', issues: [{ message: 'checksum: W-2 box 1 exceeds box 5 (verify)' }] },
      }),
    ]);
    expect(groups[0]!.rejected).toBe(1);
    expect(groups[0]!.issues).toEqual(['checksum: W-2 box 1 exceeds box 5 (verify)']);
  });

  it('does not repeat the same issue message across a group', () => {
    const groups = groupTraces([
      row({ trace_id: 't2', ts: '2026-08-30T11:00:00.000Z', validation: 'rejected', detail: { output_hash: 'a', issues: [{ message: 'same' }] } }),
      row({ trace_id: 't1', ts: '2026-08-30T10:00:00.000Z', validation: 'rejected', detail: { output_hash: 'b', issues: [{ message: 'same' }] } }),
    ]);
    expect(groups[0]!.issues).toEqual(['same']);
  });

  it('is empty for a workspace that has never spent a model call', () => {
    expect(groupTraces([])).toEqual([]);
  });
});
