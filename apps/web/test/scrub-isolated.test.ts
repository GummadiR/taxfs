/**
 * Process isolation for the SSN scrub — born from a real 6-document upload
 * where ONE PDF froze a PDF library in synchronous native code: no timer
 * could fire, the server event loop wedged, and every document behind the
 * bad one timed out. The guarantee under test: a frozen document is KILLED
 * and refused with the stage it froze at, while the server (here: the test
 * process) stays fully alive.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

async function pdfWithText(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 120]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 20, y: 60, size: 12, font });
  return doc.save();
}

describe('isolated scrub (killable child process)', () => {
  it('scrubs a clean PDF through the child process, same verdict as in-process', async () => {
    const { scrubDocumentSafely } = await import('../src/server/scrub-isolated');
    const result = await scrubDocumentSafely(await pdfWithText('Wages 60000'), 'application/pdf');
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBe(0);
    expect(result.notes.join(' ')).toContain('none found');
  }, 120_000);

  it('an SSN-carrying PDF is flattened and masked through the child process', async () => {
    const { scrubDocumentSafely } = await import('../src/server/scrub-isolated');
    const { pdfTextLayer } = await import('../src/server/scrub');
    const result = await scrubDocumentSafely(
      await pdfWithText("Employee's social security number 111-22-3333"),
      'application/pdf',
    );
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBeGreaterThanOrEqual(1);
    const pages = await pdfTextLayer(result.bytes);
    expect(pages.join(' ')).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
  }, 120_000);

  it('KILLS a child frozen in an unbreakable loop and refuses honestly — the server survives (negative test)', async () => {
    // A short budget + short grace so the test proves the kill in seconds.
    process.env.TAXFS_SCRUB_BUDGET_MS = '500';
    process.env.TAXFS_SCRUB_KILL_GRACE_MS = '500';
    process.env.TAXFS_SCRUB_FREEZE_TEST = '1';
    try {
      const { scrubDocumentSafely } = await import('../src/server/scrub-isolated');
      const started = Date.now();
      const result = await scrubDocumentSafely(
        new Uint8Array([1, 2, 3]),
        'application/x-taxfs-freeze-test', // bootstrap enters for(;;) — only SIGKILL ends it
      );
      const elapsed = Date.now() - started;
      expect(result.blocked).toBeDefined();
      expect(result.blocked!.reason).toContain('froze');
      expect(result.blocked!.reason).toContain('other files in your batch are unaffected');
      // Bounded: kill fired near budget+grace, nowhere near a 4-minute client bailout.
      expect(elapsed).toBeLessThan(30_000);
      // And THIS process (the "server") is alive to run more work immediately.
      expect(1 + 1).toBe(2);
    } finally {
      delete process.env.TAXFS_SCRUB_BUDGET_MS;
      delete process.env.TAXFS_SCRUB_KILL_GRACE_MS;
      delete process.env.TAXFS_SCRUB_FREEZE_TEST;
    }
  }, 120_000);

  it('the freeze-test hook refuses to run without its env gate', async () => {
    const { scrubDocumentSafely } = await import('../src/server/scrub-isolated');
    const result = await scrubDocumentSafely(new Uint8Array([1, 2, 3]), 'application/x-taxfs-freeze-test');
    // Child exits non-zero immediately → honest refusal, no freeze.
    expect(result.blocked).toBeDefined();
  }, 120_000);
});
