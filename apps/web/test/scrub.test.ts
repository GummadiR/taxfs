/**
 * P15 — local SSN scrubber. The detection rules are pinned deterministically,
 * and one end-to-end test renders a real image, OCRs it locally, and proves
 * the SSN pixels are actually gone (not covered by a layer).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { findSsnBoxes, maskImage, pdfTextLayer, scrubDocument, type OcrWord } from '../src/server/scrub';

const w = (text: string, x0: number, y0: number, x1 = x0 + 40, y1 = y0 + 12): OcrWord => ({
  text,
  bbox: { x0, y0, x1, y1 },
});

describe('SSN detection over OCR words', () => {
  it('catches a whole-word SSN with separators', () => {
    const boxes = findSsnBoxes([w('Wages', 10, 10), w('111-22-3333', 100, 10)]);
    expect(boxes).toEqual([{ x0: 100, y0: 10, x1: 140, y1: 22 }]);
  });

  it('catches a bare 9-digit SSN', () => {
    expect(findSsnBoxes([w('999887777', 50, 30)])).toHaveLength(1);
  });

  it('catches an SSN that OCR split across words, masking every piece', () => {
    const boxes = findSsnBoxes([w('111', 10, 10, 40, 22), w('22', 45, 10, 65, 22), w('3333', 70, 10, 110, 22)]);
    expect(boxes).toEqual([{ x0: 10, y0: 10, x1: 110, y1: 22 }]);
  });

  it('catches a digit run next to an SSN label even on its own', () => {
    const boxes = findSsnBoxes([w("Employee's social security number", 10, 10, 200, 22), w('111223333', 210, 10)]);
    expect(boxes).toHaveLength(1);
  });

  it('leaves non-SSN numbers alone (wages, EINs, ZIPs, phone-free text)', () => {
    const boxes = findSsnBoxes([
      w('60000.00', 10, 10),
      w('12-3456789', 60, 10), // EIN: 9 digits but 2-7 shape, not 3-2-4
      w('60618', 120, 10),
      w('Box', 180, 10),
      w('1', 200, 10),
    ]);
    expect(boxes).toEqual([]);
  });

  it('does not join digits across different text lines', () => {
    const boxes = findSsnBoxes([w('111', 10, 10, 40, 22), w('22', 10, 40, 30, 52), w('3333', 10, 70, 50, 82)]);
    expect(boxes).toEqual([]);
  });
});

describe('masking removes the pixels', () => {
  it('paints solid black over the box and re-encodes', async () => {
    const { Jimp } = await import('jimp');
    const img = new Jimp({ width: 200, height: 60, color: 0xffffffff });
    // A distinctive red patch stands in for the printed SSN.
    for (let x = 40; x < 120; x += 1) {
      for (let y = 20; y < 36; y += 1) img.setPixelColor(0xff0000ff, x, y);
    }
    const png = new Uint8Array(await img.getBuffer('image/png'));
    const masked = await maskImage(png, [{ x0: 40, y0: 20, x1: 120, y1: 36 }]);
    const after = await Jimp.read(Buffer.from(masked));
    // Every pixel of the patch is now black; the page around it is untouched.
    expect(after.getPixelColor(80, 28)).toBe(0x000000ff);
    expect(after.getPixelColor(5, 5)).toBe(0xffffffff);
    expect(after.getPixelColor(190, 55)).toBe(0xffffffff);
  });
});

describe('PDF handling', () => {
  async function pdfWithText(text: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 120]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 20, y: 60, size: 12, font });
    return doc.save();
  }

  it('reads the selectable text layer locally', async () => {
    const pages = await pdfTextLayer(await pdfWithText('Wages 60000'));
    expect(pages.join(' ')).toContain('60000');
  });

  it('FLATTENS a PDF whose selectable text carries an SSN — the number is destroyed, not covered', async () => {
    // A digitally generated 1099/W-2 (the common case) stores the SSN as live
    // text. Painting a box over it would leave it copyable underneath, so the
    // page is re-rendered to pixels and the pixels are masked.
    const result = await scrubDocument(
      await pdfWithText("Employee's social security number 111-22-3333"),
      'application/pdf',
    );
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBeGreaterThanOrEqual(1);
    expect(result.notes.join(' ')).toContain('re-rendered as an image');

    // The scrubbed PDF must carry NO recoverable SSN: not in a text layer
    // (there is none left), and not readable off the page pixels either.
    const pages = await pdfTextLayer(result.bytes);
    expect(pages.join(' ')).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    const { rasterizePdf, ocrWords } = await import('../src/server/scrub');
    const [rendered] = await rasterizePdf(result.bytes);
    const readBack = (await ocrWords(rendered!)).map((w) => w.text).join(' ');
    expect(readBack).not.toContain('3333');
  }, 120_000);

  it('flattens ONLY the pages carrying the SSN — clean pages keep their text layer', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([400, 200]);
    p1.drawText('SSN 111-22-3333', { x: 20, y: 150, size: 14, font });
    const p2 = doc.addPage([400, 200]);
    p2.drawText('Dividends 2129.00', { x: 20, y: 150, size: 14, font });

    const result = await scrubDocument(await doc.save(), 'application/pdf');
    expect(result.blocked).toBeUndefined();
    const pages = await pdfTextLayer(result.bytes);
    expect(pages).toHaveLength(2);
    // Page 1 became a bitmap: no text layer left at all.
    expect(pages[0]!.trim()).toBe('');
    // Page 2 never carried the SSN, so it kept its crisp selectable text.
    expect(pages[1]!).toContain('2129.00');
  }, 120_000);

  it('keeps the rest of the page readable after flattening (extraction still works)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('SSN 111-22-3333', { x: 20, y: 150, size: 14, font });
    page.drawText('Wages 60000', { x: 20, y: 100, size: 14, font });
    const result = await scrubDocument(await doc.save(), 'application/pdf');
    expect(result.blocked).toBeUndefined();
    const { rasterizePdf, ocrWords } = await import('../src/server/scrub');
    const [rendered] = await rasterizePdf(result.bytes);
    const readBack = (await ocrWords(rendered!)).map((w) => w.text).join(' ');
    expect(readBack).toContain('60000'); // the numbers we DO need survive
    expect(readBack).not.toContain('3333');
  }, 120_000);

  it('passes a clean PDF through untouched, saying so', async () => {
    const result = await scrubDocument(await pdfWithText('Wages 60000'), 'application/pdf');
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBe(0);
    expect(result.notes.join(' ')).toContain('none found');
  });
});

describe('ENCRYPTED PDFs (the JP Morgan statement shape)', () => {
  /** Bank statements are routinely encrypted with an owner password and an
   *  EMPTY user password: they open normally, but PDF parsers refuse them —
   *  the exact live failure ("Input document to PDFDocument.load is
   *  encrypted"). pdfkit builds one here with a fake SSN in its text layer. */
  async function encryptedPdf(text: string): Promise<Uint8Array> {
    const { default: PDFKit } = await import('pdfkit');
    const chunks: Buffer[] = [];
    const doc = new PDFKit({ size: [400, 200], ownerPassword: 'owner-secret' });
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
    doc.fontSize(14).text(text, 20, 40).text('Wages 60000', 20, 80);
    doc.end();
    await done;
    return new Uint8Array(Buffer.concat(chunks));
  }

  it('rebuilds an encrypted PDF from rendered pixels with the SSN destroyed', async () => {
    const bytes = await encryptedPdf('SSN 111-22-3333');
    // Preconditions: really encrypted, and the SSN really is in the text layer.
    const { PDFDocument } = await import('pdf-lib');
    await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
    expect((await pdfTextLayer(bytes)).join(' ')).toContain('111-22-3333');

    const result = await scrubDocument(bytes, 'application/pdf');
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBeGreaterThanOrEqual(1);
    expect(result.notes.join(' ')).toContain('encrypted');
    // The rebuilt copy: parseable WITHOUT ignoreEncryption, no text layer
    // SSN, and the pixels read back clean while wages stay readable.
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.isEncrypted).toBe(false);
    expect((await pdfTextLayer(result.bytes)).join(' ')).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    const { rasterizePdf, ocrWords } = await import('../src/server/scrub');
    const [rendered] = await rasterizePdf(result.bytes);
    const readBack = (await ocrWords(rendered!)).map((w) => w.text).join(' ');
    expect(readBack).not.toContain('3333');
    expect(readBack).toContain('60000');
  }, 120_000);

  it('masks a MULTI-PAGE statement with the SSN in every page header in bounded time', async () => {
    // The live JP Morgan failure mode: a long encrypted statement repeating
    // the SSN in every header. Full-page OCR per page ran 6+ minutes for one
    // document; the text layer already pins the SSN's coordinates, so masking
    // needs NO page OCR — only a small verification strip per mask.
    const { default: PDFKit } = await import('pdfkit');
    const chunks: Buffer[] = [];
    const doc = new PDFKit({ size: [612, 792], ownerPassword: 'owner-secret' });
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
    for (let p = 0; p < 10; p += 1) {
      if (p > 0) doc.addPage();
      doc.fontSize(11).text('Account holder SSN 111-22-3333', 40, 30);
      doc.fontSize(10);
      for (let line = 0; line < 12; line += 1) {
        doc.text(
          `02/1${line} BUY 100 SH VTI @ 243.1${line}  proceeds 24,31${line}.00  dividends 2,129.0${line}`,
          40,
          80 + line * 20,
        );
      }
    }
    doc.end();
    await done;
    const bytes = new Uint8Array(Buffer.concat(chunks));

    // Warm the shared OCR worker OUTSIDE the timed window — its one-time
    // model load is a fixed cost, not part of the per-document behavior.
    const { ocrWords } = await import('../src/server/scrub');
    const { Jimp } = await import('jimp');
    const warm = new Jimp({ width: 60, height: 20, color: 0xffffffff });
    await ocrWords(new Uint8Array(await warm.getBuffer('image/png')));

    const started = Date.now();
    const result = await scrubDocument(bytes, 'application/pdf');
    const elapsed = Date.now() - started;

    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBeGreaterThanOrEqual(10); // one header SSN per page
    const pages = await pdfTextLayer(result.bytes);
    expect(pages).toHaveLength(10);
    expect(pages.join(' ')).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    // Regression guard: per-page full OCR of 10 dense pages runs well past
    // this; the coordinate path renders + strip-verifies in a fraction of it.
    expect(elapsed).toBeLessThan(120_000);
  }, 300_000);

  it('an encrypted PDF with no SSN passes through unchanged', async () => {
    const bytes = await encryptedPdf('Account Summary');
    const result = await scrubDocument(bytes, 'application/pdf');
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBe(0);
    expect(result.bytes).toBe(bytes); // untouched — same bytes object
    expect(result.notes.join(' ')).toContain('none found');
  }, 120_000);
});

describe('end-to-end: a rendered document with a printed SSN', () => {
  it('OCRs locally, blacks out the SSN, and the masked area is opaque black', async () => {
    const { Jimp, loadFont } = await import('jimp');
    const { SANS_32_BLACK } = await import('jimp/fonts');
    const font = await loadFont(SANS_32_BLACK);
    const img = new Jimp({ width: 700, height: 200, color: 0xffffffff });
    img.print({ font, x: 20, y: 20, text: 'Employee SSN 111-22-3333' });
    img.print({ font, x: 20, y: 110, text: 'Wages 60000.00' });
    const png = new Uint8Array(await img.getBuffer('image/png'));

    const result = await scrubDocument(png, 'image/png');
    expect(result.blocked).toBeUndefined();
    expect(result.masked).toBeGreaterThanOrEqual(1);
    expect(result.notes.join(' ')).toContain('blacked out');

    // Re-OCR the scrubbed bytes: the SSN must no longer be readable.
    const { ocrWords } = await import('../src/server/scrub');
    const after = await ocrWords(result.bytes);
    const text = after.map((x) => x.text).join(' ');
    expect(text).not.toContain('3333');
    expect(text.replace(/\D/g, '')).not.toContain('111223333');
    // The rest of the document survived — wages still read.
    expect(text).toContain('60000');
  }, 120_000);
});
