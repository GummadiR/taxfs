/**
 * The acknowledgment on Audit Readiness is a LEDGER ENTRY, not a button.
 *
 * The screen once wrote a bare list of critic ids straight to settings while
 * displaying, right above it, the disclosure that says a compelled ledger
 * showing documented reasoning defends and one showing bare clicks convicts.
 * The rule lives in the ported RiskLedger; these pin that the screen goes
 * THROUGH it — including the typed phrase, which is refused before anything
 * is written (§9.1 negative test).
 */
import { describe, expect, it } from 'vitest';
import { ACK_COPY, ACK_PHRASE, acknowledgeFinding } from '../src/server/risk';

describe('recording an audit-readiness acknowledgment', () => {
  it('REFUSES without the typed phrase — and says so before touching any store', async () => {
    // No database is reachable here on purpose: if the refusal did not come
    // first, this would fail on a connection error instead of a message.
    const refused = await acknowledgeFinding('u1', 'ws1', {
      findingId: 'f-1', typed: '', note: 'I read it',
    });
    expect(refused).toContain(ACK_PHRASE);
    expect(refused).toContain('Nothing was recorded');
  });

  it('REFUSES a near-miss phrase — "i acknowledge this" is not the phrase', async () => {
    for (const typed of ['i acknowledge', 'I acknowledge this', 'acknowledge', 'yes']) {
      const refused = await acknowledgeFinding('u1', 'ws1', { findingId: 'f-1', typed, note: '' });
      expect(refused, `typed: ${typed}`).toContain(ACK_PHRASE);
    }
  });

  it('accepts the phrase with surrounding whitespace — the rule is the words, not the padding', async () => {
    // Past the phrase check it needs a database, so reaching a DB failure IS
    // the proof that the phrase was accepted.
    await expect(
      acknowledgeFinding('u1', 'ws1', { findingId: 'f-1', typed: `  ${ACK_PHRASE}  `, note: '' }),
    ).rejects.toThrow();
  });

  it('the disclosure the operator sees states §7602 compellability and never calls the record private', () => {
    expect(ACK_COPY).toMatch(/7602/);
    expect(ACK_COPY).not.toMatch(/private|confidential|hidden from/i);
    expect(ACK_COPY).toMatch(/not hidden/i);
  });
});
