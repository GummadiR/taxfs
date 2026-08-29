/** Timing harness: a phone-camera-resolution page through ocrWords. */
import { it, expect } from 'vitest';
import { Jimp, loadFont } from 'jimp';
import { SANS_32_BLACK } from 'jimp/fonts';
import { ocrWords, findSsnBoxes, maskImage } from '../src/server/scrub';

it('phone-resolution page OCRs inside the budget and masks at ORIGINAL coordinates', async () => {
  // 3000×4000 white page with a printed SSN — the shape of a phone scan.
  const img = new Jimp({ width: 3000, height: 4000, color: 0xffffffff });
  const font = await loadFont(SANS_32_BLACK);
  img.print({ font, x: 900, y: 1200, text: 'SSN 123-45-6789 Donation total 500.00' });
  const png = new Uint8Array(await img.getBuffer('image/png'));

  const t0 = Date.now();
  const words = await ocrWords(png);
  const secs = (Date.now() - t0) / 1000;
  console.log(`OCR took ${secs.toFixed(1)}s for a 3000x4000 page`);
  const boxes = findSsnBoxes(words);
  expect(boxes.length).toBeGreaterThan(0);
  // Boxes are in ORIGINAL pixels: the SSN was printed near (1000, 1200).
  expect(boxes[0]!.x0).toBeGreaterThan(600);
  expect(boxes[0]!.y0).toBeGreaterThan(1000);
  expect(boxes[0]!.y1).toBeLessThan(1500);
  // Masking at those coordinates really blacks the digits out.
  const masked = await maskImage(png, boxes);
  const rescan = findSsnBoxes(await ocrWords(masked));
  expect(rescan).toHaveLength(0);
  expect(secs).toBeLessThan(60);
}, 240_000);
