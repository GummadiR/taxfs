/**
 * P15 — LOCAL SSN SCRUBBER (upload path).
 *
 * TaxFS never needs your SSN: identity fields are typed onto the printed
 * form at filing time, never stored and never mapped into a PDF. So an SSN
 * printed on an uploaded document is pure liability — it would otherwise
 * travel to the vision API for reading and land in the storage bucket.
 *
 * This module removes it BEFORE either happens. Everything here runs on the
 * user's own machine:
 *   - OCR is tesseract.js (WASM) with the language data resolved from
 *     node_modules — no CDN fetch, no network call of any kind;
 *   - masking is pixel painting via jimp;
 *   - PDF inspection is pdfjs-dist / pdf-lib, locally.
 *
 * Honesty rules baked in (a scrubber that quietly misses is worse than none):
 *   - a PDF whose SELECTABLE TEXT contains an SSN is never "painted over":
 *     a box drawn on top leaves the text extractable underneath, which is the
 *     classic redaction failure. Instead the page is RE-RENDERED to an image
 *     locally, the SSN is masked in pixels, and the rebuilt PDF carries no
 *     text layer at all — the number is gone, not hidden.
 *   - the rebuilt document is VERIFIED before it is accepted: its text layer
 *     must be SSN-free, and the masked pixels are re-scanned. Anything still
 *     matching refuses the upload.
 *   - page images we cannot decode locally are REPORTED as unscanned rather
 *     than assumed clean.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** A US SSN as printed: 123-45-6789, 123 45 6789, or 9 bare digits. */
const SSN_TEXT = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const SSN_TEXT_G = new RegExp(SSN_TEXT.source, 'g');

/** OCR often drops separators; also catch a 9-digit run next to an SSN label. */
const SSN_LABEL = /\b(ssn|social\s*security|s\.s\.\s*no|employee'?s?\s+soc)/i;

export interface ScrubBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ScrubResult {
  /** The scrubbed bytes to store and send onward (unchanged when nothing matched). */
  bytes: Uint8Array;
  /** Media type of `bytes` — images are re-encoded as PNG after masking. */
  media_type: string;
  /** How many SSN-shaped values were masked. */
  masked: number;
  /** Human-readable notes for the UI (always surfaced, never swallowed). */
  notes: string[];
  /**
   * Set when the document CANNOT be safely scrubbed — the caller must refuse
   * the upload and show `blocked.instructions`.
   */
  blocked?: { reason: string; instructions: string };
}

// ---------------------------------------------------------------------------
// OCR (local WASM; language data from node_modules — never the CDN)
// ---------------------------------------------------------------------------

export interface OcrWord {
  text: string;
  bbox: ScrubBox;
}

/**
 * Locate the packaged eng.traineddata.gz. Module resolution differs between
 * plain Node, vitest, and the Next server runtime, so try each root — and if
 * none works, THROW. Never let tesseract fall back to its CDN default: that
 * turns a local privacy step into a silent network fetch, and on a machine
 * without that route it simply hangs.
 */
function findTrainedDataGz(): string {
  const candidates = [import.meta.url, `file://${join(process.cwd(), 'package.json')}`];
  for (const from of candidates) {
    try {
      const pkg = createRequire(from).resolve('@tesseract.js-data/eng/package.json');
      const gz = join(dirname(pkg), '4.0.0', 'eng.traineddata.gz');
      if (existsSync(gz)) return gz;
    } catch {
      // try the next root
    }
  }
  throw new Error(
    'the offline OCR language model (@tesseract.js-data/eng) could not be located — run "pnpm install" in the project folder',
  );
}

/**
 * Materialize the model into a stable cache directory ONCE. tesseract loads
 * `<cachePath>/eng.traineddata` directly when it exists, so decompressing it
 * ourselves removes every path where the library would reach for the network.
 */
function ensureTrainedData(): string {
  const dir = join(process.cwd(), 'node_modules', '.cache', 'taxos-ocr');
  const target = join(dir, 'eng.traineddata');
  try {
    if (!existsSync(target)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, gunzipSync(readFileSync(findTrainedDataGz())));
    }
    return dir;
  } catch {
    // Read-only or unusual install layout: fall back to the temp directory.
    const fallbackDir = join(tmpdir(), 'taxos-ocr');
    const fallback = join(fallbackDir, 'eng.traineddata');
    if (!existsSync(fallback)) {
      mkdirSync(fallbackDir, { recursive: true });
      writeFileSync(fallback, gunzipSync(readFileSync(findTrainedDataGz())));
    }
    return fallbackDir;
  }
}

/**
 * One OCR worker for the process. Creating a worker loads the WASM core and
 * a 23 MB model — doing that per page turned a stack of documents into a
 * stack of cold starts.
 */
let workerPromise: Promise<Awaited<ReturnType<typeof import('tesseract.js').createWorker>>> | null = null;

async function ocrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const dir = ensureTrainedData();
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng', 1, {
        langPath: dir,
        cachePath: dir,
        gzip: false, // we already decompressed it
        // Silence the default logger; nothing about the document should be logged.
        logger: () => {},
        errorHandler: () => {},
      });
    })().catch((e: unknown) => {
      workerPromise = null; // let the next upload retry rather than wedging
      throw e;
    });
  }
  return workerPromise;
}

/** Run OCR over image bytes and return every word with its pixel box. */
export async function ocrWords(png: Uint8Array): Promise<OcrWord[]> {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          words.push({ text: w.text, bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 } });
        }
      }
    }
  }
  return words;
}

/**
 * Which OCR words to black out. Pure function — the unit tests pin the
 * detection rules here without needing a real scan.
 *
 * Matches, in order of confidence:
 *  1. a single word that IS an SSN (123-45-6789 / 123456789);
 *  2. consecutive words that CONCATENATE into an SSN (OCR splits on dashes:
 *     "123" "45" "6789") — all participating words are masked;
 *  3. a bare 9-digit run, or a 3-2-4 split, following an SSN label on the
 *     same text line ("Employee's social security number").
 */
export function findSsnBoxes(words: readonly OcrWord[]): ScrubBox[] {
  const boxes: ScrubBox[] = [];
  const digitsOf = (s: string): string => s.replace(/\D/g, '');
  const union = (list: readonly OcrWord[]): ScrubBox => ({
    x0: Math.min(...list.map((w) => w.bbox.x0)),
    y0: Math.min(...list.map((w) => w.bbox.y0)),
    x1: Math.max(...list.map((w) => w.bbox.x1)),
    y1: Math.max(...list.map((w) => w.bbox.y1)),
  });
  const sameLine = (a: OcrWord, b: OcrWord): boolean => {
    const aMid = (a.bbox.y0 + a.bbox.y1) / 2;
    return aMid >= b.bbox.y0 && aMid <= b.bbox.y1;
  };

  const consumed = new Set<number>();
  for (let i = 0; i < words.length; i += 1) {
    if (consumed.has(i)) continue;
    const w = words[i]!;
    // (1) whole-word SSN. With separators it must have the 3-2-4 SSN shape —
    // an EIN (12-3456789) also carries nine digits and must NOT be masked
    // (the extractor tokenizes EINs, and over-masking loses payer identity).
    const bare = /^\d{9}$/.test(w.text.trim());
    if (bare || SSN_TEXT.test(w.text)) {
      boxes.push(w.bbox);
      consumed.add(i);
      continue;
    }
    // (2) consecutive words concatenating to an SSN — OCR routinely splits on
    // the dashes. Require the 3-2-4 digit-length shape, same reason as above.
    const lens: number[] = [digitsOf(w.text).length];
    if (lens[0] !== 3 || !/^\d{3}[\s.-]*$/.test(w.text.trim())) continue;
    let acc = digitsOf(w.text);
    const group: OcrWord[] = [w];
    for (let j = i + 1; j < words.length && j <= i + 3; j += 1) {
      const next = words[j]!;
      if (!sameLine(w, next)) break;
      const d = digitsOf(next.text);
      // Only pure digit/separator tokens may join a split SSN.
      if (d.length === 0 || !/^[\d\s.-]+$/.test(next.text)) break;
      acc += d;
      lens.push(d.length);
      group.push(next);
      if (acc.length === 9) {
        // 3-2-4 across two or three tokens ("111" "22" "3333" / "111" "223333")
        const shape = lens.join('-');
        if (shape === '3-2-4' || shape === '3-6' || shape === '3-2-2-2') {
          boxes.push(union(group));
          group.forEach((_, k) => consumed.add(i + k));
        }
        break;
      }
      if (acc.length > 9) break;
    }
  }

  // (3) label-adjacent digit runs the shape rules above may have missed
  for (let i = 0; i < words.length; i += 1) {
    if (!SSN_LABEL.test(words[i]!.text)) continue;
    for (let j = i + 1; j < words.length && j <= i + 8; j += 1) {
      const cand = words[j]!;
      if (!sameLine(words[i]!, cand)) continue;
      const d = digitsOf(cand.text);
      if (d.length === 9 && !boxes.some((b) => b.x0 === cand.bbox.x0 && b.y0 === cand.bbox.y0)) {
        boxes.push(cand.bbox);
      }
    }
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Image masking
// ---------------------------------------------------------------------------

/** Paint solid black over each box and re-encode as PNG (flattened: the
 *  masked pixels are GONE, not layered over). */
export async function maskImage(bytes: Uint8Array, boxes: readonly ScrubBox[]): Promise<Uint8Array> {
  const { Jimp } = await import('jimp');
  const img = await Jimp.read(Buffer.from(bytes));
  const pad = 2; // cover anti-aliased edges of the glyphs
  for (const b of boxes) {
    const x = Math.max(0, Math.floor(b.x0) - pad);
    const y = Math.max(0, Math.floor(b.y0) - pad);
    const w = Math.min(img.width - x, Math.ceil(b.x1 - b.x0) + pad * 2);
    const h = Math.min(img.height - y, Math.ceil(b.y1 - b.y0) + pad * 2);
    if (w <= 0 || h <= 0) continue;
    for (let px = x; px < x + w; px += 1) {
      for (let py = y; py < y + h; py += 1) {
        img.setPixelColor(0x000000ff, px, py);
      }
    }
  }
  return new Uint8Array(await img.getBuffer('image/png'));
}

async function scrubImageBytes(bytes: Uint8Array): Promise<ScrubResult> {
  const words = await ocrWords(bytes);
  const boxes = findSsnBoxes(words);
  if (boxes.length === 0) {
    return { bytes, media_type: 'image/png', masked: 0, notes: ['Scanned locally for SSNs — none found.'] };
  }
  const masked = await maskImage(bytes, boxes);
  return {
    bytes: masked,
    media_type: 'image/png',
    masked: boxes.length,
    notes: [
      `${boxes.length} Social Security number${boxes.length === 1 ? '' : 's'} blacked out on your machine before this document was stored or read.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// PDF handling
// ---------------------------------------------------------------------------

/** pdfjs asset roots, resolved from the installed package. Without these,
 *  pdfjs warns and substitutes fonts — a page can render blank or garbled,
 *  which for us would mean masking the wrong pixels. Local paths only. */
function pdfjsAssets(): { standardFontDataUrl: string; cMapUrl: string } {
  for (const from of [import.meta.url, `file://${join(process.cwd(), 'package.json')}`]) {
    try {
      const dir = dirname(createRequire(from).resolve('pdfjs-dist/package.json'));
      return { standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, cMapUrl: `${join(dir, 'cmaps')}/` };
    } catch {
      // try the next root
    }
  }
  return { standardFontDataUrl: '', cMapUrl: '' };
}

function pdfjsOptions(bytes: Uint8Array): Record<string, unknown> {
  return {
    data: new Uint8Array(bytes),
    // No worker thread and no external font/cmap fetching.
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    cMapPacked: true,
    ...pdfjsAssets(),
  };
}

/** Selectable text of every page, via pdfjs (local, no worker network use). */
export async function pdfTextLayer(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument(
    pdfjsOptions(bytes) as Parameters<typeof pdfjs.getDocument>[0],
  ).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' '),
    );
  }
  await doc.cleanup();
  return pages;
}

/**
 * Per-page text items WITH COORDINATES. For a digital PDF this pinpoints an
 * SSN's exact position without any OCR — the difference between minutes and
 * seconds on a 30-page statement whose header repeats the SSN on every page.
 * Boxes come back in RASTER pixel coordinates for the given scale (PDF pages
 * have a bottom-left origin; bitmaps a top-left one — converted here).
 */
export async function pdfTextWords(bytes: Uint8Array, scale: number): Promise<OcrWord[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument(
    pdfjsOptions(bytes) as Parameters<typeof pdfjs.getDocument>[0],
  ).promise;
  const pages: OcrWord[][] = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const words: OcrWord[] = [];
      for (const it of content.items) {
        if (!('str' in it) || it.str.trim() === '') continue;
        const x = it.transform[4] as number;
        const y = it.transform[5] as number;
        const h = it.height || Math.abs(it.transform[3] as number) || 12;
        const w = it.width || h * it.str.length * 0.6;
        words.push({
          text: it.str,
          bbox: {
            x0: x * scale,
            y0: (viewport.height - y - h) * scale,
            x1: (x + w) * scale,
            y1: (viewport.height - y + h * 0.25) * scale, // descender slack
          },
        });
      }
      pages.push(words);
    }
  } finally {
    await doc.cleanup();
  }
  return pages;
}

/** Crop a horizontal strip around a box (full box + padding) for fast
 *  verification OCR — a strip reads ~20× faster than a full page. Returns the
 *  strip and its origin on the page, so page boxes can be mapped into it. */
async function cropStrip(
  png: Uint8Array,
  box: ScrubBox,
  pad = 24,
): Promise<{ strip: Uint8Array; x: number; y: number }> {
  const { Jimp } = await import('jimp');
  const img = await Jimp.read(Buffer.from(png));
  const y = Math.max(0, Math.floor(box.y0) - pad);
  const h = Math.min(img.height - y, Math.ceil(box.y1 - box.y0) + pad * 2);
  const x = Math.max(0, Math.floor(box.x0) - pad * 4);
  const w = Math.min(img.width - x, Math.ceil(box.x1 - box.x0) + pad * 8);
  if (w <= 0 || h <= 0) return { strip: png, x: 0, y: 0 };
  img.crop({ x, y, w, h });
  return { strip: new Uint8Array(await img.getBuffer('image/png')), x, y };
}

/**
 * Mask boxes on a page and VERIFY each masked area by strip OCR. Two ways to
 * fail (both return null → the caller must fall back or block):
 *  - the strip still reads as an SSN (mask landed in the wrong place);
 *  - a digit-bearing OCR word overlaps the painted rectangle (mask landed in
 *    the right place but did not fully cover the glyphs — a partial SSN is
 *    still a leak).
 */
async function maskAndVerifyStrips(png: Uint8Array, boxes: readonly ScrubBox[]): Promise<Uint8Array | null> {
  const paintedPage = await maskImage(png, boxes);
  for (const box of boxes) {
    const { strip, x, y } = await cropStrip(paintedPage, box);
    const words = await ocrWords(strip);
    if (findSsnBoxes(words).length > 0) return null;
    const local = { x0: box.x0 - x, y0: box.y0 - y, x1: box.x1 - x, y1: box.y1 - y };
    for (const w of words) {
      if (!/\d{2}/.test(w.text)) continue;
      const overlapW = Math.min(w.bbox.x1, local.x1) - Math.max(w.bbox.x0, local.x0);
      const overlapH = Math.min(w.bbox.y1, local.y1) - Math.max(w.bbox.y0, local.y0);
      if (overlapW > 3 && overlapH > 3) return null; // digits survived inside the mask area
    }
  }
  return paintedPage;
}

/**
 * Render every page to a PNG bitmap, locally. This is what makes redaction
 * REAL for a text-layer PDF: once a page is pixels, the characters no longer
 * exist as text, so masked pixels cannot be selected, copied, or extracted.
 * pdfjs draws into a prebuilt @napi-rs/canvas surface — no network, no
 * external font fetching.
 */
export async function rasterizePdf(
  bytes: Uint8Array,
  scale = 2,
  onlyPages?: readonly number[],
): Promise<Uint8Array[]> {
  // PDFium compiled to WASM (@hyzyla/pdfium): Chrome's PDF engine with NO
  // native per-platform binary — the same reason the OCR runs on tesseract's
  // WASM build. A native canvas dependency here repeatedly failed to install
  // on Windows (pnpm optional-dependency linking); WASM ends that class of
  // failure everywhere.
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const { Jimp } = await import('jimp');
  const lib = await PDFiumLibrary.init();
  const pages: Uint8Array[] = [];
  try {
    const doc = await lib.loadDocument(Buffer.from(bytes));
    try {
      for (let i = 0; i < doc.getPageCount(); i += 1) {
        if (onlyPages && !onlyPages.includes(i + 1)) continue;
        const rendered = await doc.getPage(i).render({ scale, render: 'bitmap' });
        const img = Jimp.fromBitmap({
          data: Buffer.from(rendered.data),
          width: rendered.width,
          height: rendered.height,
        });
        pages.push(new Uint8Array(await img.getBuffer('image/png')));
      }
    } finally {
      doc.destroy();
    }
  } finally {
    lib.destroy();
  }
  return pages;
}

/**
 * Rebuild the document, replacing ONLY the pages that carried an SSN with
 * their masked bitmap. Untouched pages are copied through as-is, so a long
 * brokerage statement keeps its crisp vector text (and its small file size)
 * everywhere the number never appeared.
 */
async function pdfWithFlattenedPages(
  original: Uint8Array,
  flattened: ReadonlyMap<number, Uint8Array>,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(original);
  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, src.getPageIndices());
  for (const [i, copy] of copies.entries()) {
    const bitmap = flattened.get(i + 1); // page numbers are 1-based
    if (!bitmap) {
      out.addPage(copy);
      continue;
    }
    const { width, height } = src.getPage(i).getSize();
    const img = await out.embedPng(bitmap);
    const page = out.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  return new Uint8Array(await out.save());
}

/**
 * A text-layer PDF carrying an SSN: FLATTEN it. Each page is re-rendered to
 * pixels, the SSN is masked in those pixels, and the pages are reassembled
 * into a PDF with no text layer — so the number is destroyed rather than
 * covered. The result is then VERIFIED (text layer + a re-scan of the
 * pixels) before it is allowed through.
 */
async function flattenAndMaskPdf(
  bytes: Uint8Array,
  textPages: readonly string[],
  textHits: number,
  notes: string[],
): Promise<ScrubResult> {
  // Only the pages whose text actually carries an SSN need flattening.
  const scale = 2;
  const hitPages = textPages
    .map((t, i) => (SSN_TEXT.test(t) ? i + 1 : 0))
    .filter((n) => n > 0);
  const rendered = await rasterizePdf(bytes, scale, hitPages);
  // The text layer told us these pages carry the SSN — pdfjs also tells us
  // WHERE. Masking from text coordinates and strip-verifying skips full-page
  // OCR entirely; OCR remains only as the fallback locator.
  const textWords = await pdfTextWords(bytes, scale).catch(() => null);
  let masked = 0;
  const maskedPages = new Map<number, Uint8Array>();
  const changed: Uint8Array[] = [];
  for (const [k, png] of rendered.entries()) {
    const pageNo = hitPages[k]!;
    if (textWords) {
      const boxes = findSsnBoxes(textWords[pageNo - 1] ?? []);
      if (boxes.length > 0) {
        const painted = await maskAndVerifyStrips(png, boxes);
        if (painted) {
          maskedPages.set(pageNo, painted); // strip-verified in place
          masked += boxes.length;
          continue;
        }
        // Verification failed — fall through to the OCR locator, whose own
        // masks are re-scanned below (and a residual there blocks the upload).
      }
    }
    const boxes = findSsnBoxes(await ocrWords(png));
    if (boxes.length === 0) {
      maskedPages.set(pageNo, png);
    } else {
      const paintedPage = await maskImage(png, boxes);
      maskedPages.set(pageNo, paintedPage);
      changed.push(paintedPage);
      masked += boxes.length;
    }
  }
  const rebuilt = await pdfWithFlattenedPages(bytes, maskedPages);

  // Verify, do not assume: the rebuilt file's text layer must be SSN-free,
  // and the pages that were MASKED must re-scan clean (unchanged pages were
  // already scanned — re-OCRing identical bytes proves nothing twice).
  const residualText = (await pdfTextLayer(rebuilt).catch(() => [] as string[]))
    .reduce((n, t) => n + (t.match(SSN_TEXT_G)?.length ?? 0), 0);
  let residualPixels = 0;
  for (const png of changed) residualPixels += findSsnBoxes(await ocrWords(png)).length;
  if (residualText > 0 || residualPixels > 0) {
    return {
      bytes,
      media_type: 'application/pdf',
      masked: 0,
      notes,
      blocked: {
        reason:
          'This PDF carries your Social Security number, and the automatic redaction could not be verified as complete afterwards — so the upload was refused rather than pretending the number was removed.',
        instructions:
          'Black out the SSN yourself (or upload a copy of the page with it covered) and try again. TaxFS never needs your SSN — it is typed onto the printed form at filing time.',
      },
    };
  }

  notes.unshift(
    `This PDF had your Social Security number as selectable text (${textHits} occurrence${textHits === 1 ? '' : 's'}). ` +
      `The ${hitPages.length} affected page${hitPages.length === 1 ? '' : 's'} ${hitPages.length === 1 ? 'was' : 'were'} re-rendered as an image on your machine and the number blacked out in the pixels — ` +
      'destroyed rather than covered. Nothing carrying it was stored or sent.',
  );
  return { bytes: rebuilt, media_type: 'application/pdf', masked: Math.max(masked, textHits), notes };
}

/**
 * Scrub a PDF. Two cases:
 *  - SSN in the selectable text layer → flatten the pages to images and mask
 *    the pixels (painting over live text would leave it extractable);
 *  - scanned pages → mask the embedded JPEG page images in place.
 */

/** True when the PDF carries encryption (banks routinely encrypt statements
 *  with an owner password and an EMPTY user password — they open normally in
 *  a viewer, but PDF parsers refuse them). */
async function isEncryptedPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.isEncrypted;
  } catch {
    // Unparseable by pdf-lib entirely — treat as encrypted so the rebuild
    // path (which never parses the original) handles it.
    return true;
  }
}

/**
 * An ENCRYPTED PDF (the JP Morgan statement shape): pdf-lib cannot parse or
 * copy its streams, but PDFium decrypts for rendering. So every page is
 * re-rendered to pixels locally and — when any SSN exists — the document is
 * rebuilt purely from those images, never touching the original's encrypted
 * content. No SSN anywhere ⇒ the original passes through unchanged.
 */
async function flattenEncryptedPdf(
  bytes: Uint8Array,
  textPages: readonly string[],
  textHits: number,
  notes: string[],
): Promise<ScrubResult> {
  const scale = 2;
  const textParsed = textPages.length > 0;

  // Which pages actually need the (slow) OCR pass? A digital page whose text
  // layer parsed and carries no SSN is already proven clean — the same trust
  // the unencrypted path places in the text layer. OCR is reserved for pages
  // that HIT (to locate the pixels) and pages that look like image scans
  // (little/no text, so the text layer proves nothing). This is the
  // difference between ~30 OCR passes on a brokerage statement and ~2.
  const needsOcr = (idx0: number): boolean => {
    if (!textParsed) return true;
    const text = textPages[idx0] ?? '';
    return SSN_TEXT.test(text) || text.trim().length < 20;
  };

  // Fully clean digital document: text parsed, no SSN anywhere, every page
  // carries real text — nothing to redact, nothing to rebuild.
  const pageCount = textParsed ? textPages.length : 0;
  if (textParsed && textHits === 0 && textPages.every((t) => t.trim().length >= 20)) {
    notes.unshift(
      `Encrypted PDF: the text of all ${pageCount} page${pageCount === 1 ? '' : 's'} was scanned for SSNs on your machine — none found; the document passed through unchanged.`,
    );
    return { bytes, media_type: 'application/pdf', masked: 0, notes };
  }

  // For pages whose TEXT LAYER carries the SSN, pdfjs already knows exactly
  // where it sits — no OCR needed to find it, and only a small strip around
  // each mask needs OCR to verify. Full-page OCR is reserved for image-scan
  // pages (little/no text) where there is nothing else to go on. On a 30-page
  // statement with the SSN in every header this is minutes → seconds.
  const anyTextHit = textParsed && textPages.some((t) => SSN_TEXT.test(t));
  const textWords = anyTextHit
    ? await pdfTextWords(bytes, scale).catch(() => null)
    : null;

  const pages = await rasterizePdf(bytes, scale);
  let masked = 0;
  let verifyFailed = false;
  const outPages: Uint8Array[] = [];
  const maskedIdx: number[] = [];
  for (const [k, png] of pages.entries()) {
    const pageText = textPages[k] ?? '';
    if (textParsed && textWords && SSN_TEXT.test(pageText)) {
      const boxes = findSsnBoxes(textWords[k] ?? []);
      if (boxes.length > 0) {
        const painted = await maskAndVerifyStrips(png, boxes);
        if (painted) {
          outPages.push(painted); // strip-verified in place — no re-scan needed
          masked += boxes.length;
          continue;
        }
        verifyFailed = true; // mask could not be verified — refuse below
        outPages.push(png);
        continue;
      }
      // The text layer says SSN but the coordinates did not pin it — fall
      // through to full-page OCR rather than trusting a miss.
    }
    if (!needsOcr(k)) {
      outPages.push(png); // digital page, text proven clean — no OCR needed
      continue;
    }
    const boxes = findSsnBoxes(await ocrWords(png));
    if (boxes.length === 0) {
      outPages.push(png);
    } else {
      outPages.push(await maskImage(png, boxes));
      maskedIdx.push(k);
      masked += boxes.length;
    }
  }
  if (verifyFailed) {
    return {
      bytes,
      media_type: 'application/pdf',
      masked: 0,
      notes,
      blocked: {
        reason:
          'This encrypted PDF carries your Social Security number, and the automatic redaction could not be verified as complete afterwards — so the upload was refused rather than pretending the number was removed.',
        instructions:
          'Black out the SSN yourself (or upload a copy of the page with it covered) and try again. TaxFS never needs your SSN — it is typed onto the printed form at filing time.',
      },
    };
  }
  if (textHits === 0 && masked === 0) {
    notes.unshift(
      `Encrypted PDF: all ${pages.length} page${pages.length === 1 ? '' : 's'} were scanned for SSNs on your machine — none found; the document passed through unchanged.`,
    );
    return { bytes, media_type: 'application/pdf', masked: 0, notes };
  }
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  for (const png of outPages) {
    const img = await out.embedPng(png);
    const page = out.addPage([img.width / scale, img.height / scale]);
    page.drawImage(img, { x: 0, y: 0, width: img.width / scale, height: img.height / scale });
  }
  const rebuilt = new Uint8Array(await out.save());

  // Verify, do not assume — but only re-scan what CHANGED: pages that were
  // masked. Unmasked pages are byte-identical to what was already scanned
  // (or text-proven clean); re-OCRing identical bytes proves nothing twice.
  const residualText = (await pdfTextLayer(rebuilt).catch(() => [] as string[]))
    .reduce((n, t) => n + (t.match(SSN_TEXT_G)?.length ?? 0), 0);
  let residualPixels = 0;
  for (const k of maskedIdx) residualPixels += findSsnBoxes(await ocrWords(outPages[k]!)).length;
  if (residualText > 0 || residualPixels > 0) {
    return {
      bytes,
      media_type: 'application/pdf',
      masked: 0,
      notes,
      blocked: {
        reason:
          'This encrypted PDF carries your Social Security number, and the automatic redaction could not be verified as complete afterwards — so the upload was refused rather than pretending the number was removed.',
        instructions:
          'Black out the SSN yourself (or upload a copy of the page with it covered) and try again. TaxFS never needs your SSN — it is typed onto the printed form at filing time.',
      },
    };
  }
  notes.unshift(
    `This PDF is encrypted (bank statements usually are), so its ${pages.length} page${pages.length === 1 ? '' : 's'} were re-rendered as images on your machine` +
      `${masked > 0 || textHits > 0 ? ` and ${Math.max(masked, textHits)} Social Security number${Math.max(masked, textHits) === 1 ? '' : 's'} blacked out in the pixels` : ''}` +
      ' — the rebuilt copy contains none of the original\u2019s encrypted content and no text layer.',
  );
  return { bytes: rebuilt, media_type: 'application/pdf', masked: Math.max(masked, textHits), notes };
}

async function scrubPdfBytes(bytes: Uint8Array): Promise<ScrubResult> {
  const notes: string[] = [];
  let textPages: string[];
  try {
    textPages = await pdfTextLayer(bytes);
  } catch {
    textPages = [];
    notes.push('The PDF text layer could not be read locally; page images were still scanned.');
  }
  const textHits = textPages.reduce((n, t) => n + (t.match(SSN_TEXT_G)?.length ?? 0), 0);
  // Encrypted documents take the rebuild-from-pixels path for EVERYTHING —
  // pdf-lib cannot parse their streams (selective page-copying included).
  if (await isEncryptedPdf(bytes)) return flattenEncryptedPdf(bytes, textPages, textHits, notes);
  if (textHits > 0) return flattenAndMaskPdf(bytes, textPages, textHits, notes);

  // Scanned pages: mask embedded JPEG images in place.
  const { PDFDocument, PDFRawStream, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  let masked = 0;
  let undecodable = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const filter = dict.get(PDFName.of('Filter'))?.toString() ?? '';
    if (!filter.includes('DCTDecode')) {
      undecodable += 1; // Flate/CCITT page images: decoding needs predictors we do not implement
      continue;
    }
    const raw = obj.getContents();
    let words: OcrWord[];
    try {
      words = await ocrWords(raw);
    } catch {
      undecodable += 1;
      continue;
    }
    const boxes = findSsnBoxes(words);
    if (boxes.length === 0) continue;
    const { Jimp } = await import('jimp');
    const painted = await maskImage(raw, boxes);
    // Re-encode as JPEG so the existing /DCTDecode dict stays valid.
    const jpeg = new Uint8Array(await (await Jimp.read(Buffer.from(painted))).getBuffer('image/jpeg'));
    const newStream = PDFRawStream.of(dict, jpeg);
    dict.set(PDFName.of('Length'), doc.context.obj(jpeg.length));
    doc.context.assign(ref, newStream);
    masked += boxes.length;
  }
  if (undecodable > 0) {
    notes.push(
      `${undecodable} page image${undecodable === 1 ? '' : 's'} could not be decoded locally, so ${undecodable === 1 ? 'it was' : 'they were'} NOT scanned for SSNs — check ${undecodable === 1 ? 'it' : 'them'} yourself, or upload the page as a PNG to have it scrubbed automatically.`,
    );
  }
  if (masked === 0) {
    notes.unshift('Scanned locally for SSNs — none found in the text layer or the page images.');
    return { bytes, media_type: 'application/pdf', masked: 0, notes };
  }
  notes.unshift(
    `${masked} Social Security number${masked === 1 ? '' : 's'} blacked out on your machine before this document was stored or read.`,
  );
  return { bytes: new Uint8Array(await doc.save()), media_type: 'application/pdf', masked, notes };
}

/**
 * Entry point: scrub an uploaded document locally. Never throws — an
 * internal failure returns a `blocked` result rather than silently letting
 * an unscrubbed document through.
 */
export async function scrubDocument(bytes: Uint8Array, mediaType: string): Promise<ScrubResult> {
  try {
    if (mediaType === 'application/pdf') return await scrubPdfBytes(bytes);
    return await scrubImageBytes(bytes);
  } catch (e) {
    return {
      bytes,
      media_type: mediaType,
      masked: 0,
      notes: [],
      blocked: {
        reason: `The local SSN scan could not complete (${e instanceof Error ? e.message : String(e)}), so the upload was refused rather than sending an unscanned document.`,
        instructions:
          'Try uploading the document as a PNG or JPEG image. If it keeps failing, black out the SSN yourself before uploading — TaxFS never needs it.',
      },
    };
  }
}
