/**
 * PROCESS-ISOLATED SSN scrub.
 *
 * Found the hard way (a real 6-document upload): one PDF froze a PDF
 * library inside synchronous native/WASM code. No JavaScript timer can fire
 * while that happens, so the in-process time budget in scrub.ts never got
 * its turn, the Next server's event loop wedged, and every document BEHIND
 * the bad one timed out against a frozen server.
 *
 * The only defense that works no matter which library freezes is a process
 * boundary: each document is scrubbed in its own disposable `node` child,
 * and the parent KILLS the child outright when the budget expires — a kill
 * works even against frozen native code. The server itself never runs
 * document-parsing code on its own event loop, so it can never wedge again,
 * and a frozen document costs exactly one refusal while the rest of the
 * batch continues.
 *
 * Mechanics: scrub.ts deliberately has no app-internal imports, so it can be
 * transpiled (type-strip only) into a standalone ES module once and cached
 * under node_modules/.cache. The child bootstrap loads it, scrubs one file,
 * and writes the result. Stage breadcrumbs from TAXFS_SCRUB_TRACE let a
 * timeout name WHERE the document froze. If the setup is unavailable the
 * upload is REFUSED, never scrubbed in-process: the same missing node_modules
 * that blocks the child also breaks tesseract's worker resolution inside the
 * bundled server, where the failure escapes as an uncaughtException and takes
 * the whole server with it instead of costing one upload.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScrubResult } from './scrub';

/** Read at CALL time so tests (and an operator) can tune without a restart.
 *  The kill grace is extra time past the soft budget: when the child's event
 *  loop is alive its own in-process budget answers first with a proper
 *  refusal; the kill is only for a child frozen in native code. */
const scrubBudgetMs = (): number => Number(process.env.TAXFS_SCRUB_BUDGET_MS ?? 180_000);
const killGraceMs = (): number => Number(process.env.TAXFS_SCRUB_KILL_GRACE_MS ?? 15_000);

/**
 * The web app root — the directory whose node_modules carries tesseract.js,
 * jimp, pdfjs-dist etc. The transpiled module must live UNDER it so bare
 * `import('tesseract.js')` specifiers resolve (Node walks ancestor
 * node_modules from the importing FILE's path, and in a pnpm workspace those
 * packages exist only in apps/web/node_modules).
 */
function findWebRoot(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundlers can virtualize import.meta.url; the cwd candidates remain
  }
  candidates.push(process.cwd(), join(process.cwd(), 'apps', 'web'));
  for (let dir of candidates) {
    for (let hops = 0; hops < 6; hops += 1) {
      if (existsSync(join(dir, 'node_modules', 'tesseract.js'))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/** Where the untranspiled source lives, for the one-time transpile. */
function findScrubSource(webRoot: string): string | null {
  const p = join(webRoot, 'src', 'server', 'scrub.ts');
  return existsSync(p) ? p : null;
}

const CHILD_BOOTSTRAP = `import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [runtime, inFile, mediaType, outFile] = process.argv.slice(2);
process.on('unhandledRejection', (e) => { console.error(e); process.exit(3); });
// Test hook: a deliberate hard freeze, to prove the parent's kill works
// against a child that can never answer. Refuses to run outside tests.
if (mediaType === 'application/x-taxfs-freeze-test') {
  if (process.env.TAXFS_SCRUB_FREEZE_TEST !== '1') { console.error('freeze test not enabled'); process.exit(3); }
  for (;;) { /* frozen on purpose — only SIGKILL ends this */ }
}
const mod = await import(pathToFileURL(runtime).href);
const bytes = new Uint8Array(readFileSync(inFile));
const res = await mod.scrubDocument(bytes, mediaType);
writeFileSync(outFile + '.bin', Buffer.from(res.bytes));
writeFileSync(outFile, JSON.stringify({ media_type: res.media_type, masked: res.masked, notes: res.notes, blocked: res.blocked ?? null }));
// tesseract's worker thread would otherwise keep the process alive.
process.exit(0);
`;

interface Runtime {
  runtimePath: string;
  bootstrapPath: string;
  webRoot: string;
  workDir: string;
}

let runtimePromise: Promise<Runtime | null> | null = null;

/**
 * Transpile scrub.ts (type-strip only — it has no app-internal imports) into
 * the cache once, alongside the child bootstrap. Re-done when the source
 * changes (mtime+size key). Any failure → null → the upload is refused.
 */
async function prepareRuntime(): Promise<Runtime | null> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        const webRoot = findWebRoot();
        if (!webRoot) return null;
        const src = findScrubSource(webRoot);
        if (!src) return null;
        const dir = join(webRoot, 'node_modules', '.cache', 'taxfs-scrub');
        mkdirSync(join(dir, 'work'), { recursive: true });
        const st = statSync(src);
        const stampPath = join(dir, 'stamp.txt');
        const stamp = `${st.mtimeMs}:${st.size}`;
        const runtimePath = join(dir, 'scrub-runtime.mjs');
        const bootstrapPath = join(dir, 'scrub-child.mjs');
        const fresh =
          existsSync(runtimePath) &&
          existsSync(bootstrapPath) &&
          existsSync(stampPath) &&
          readFileSync(stampPath, 'utf8') === stamp;
        if (!fresh) {
          const ts = await import('typescript');
          const out = ts.transpileModule(readFileSync(src, 'utf8'), {
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2022,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
          });
          const writeAtomic = (target: string, content: string) => {
            const tmp = `${target}.${process.pid}.tmp`;
            writeFileSync(tmp, content);
            renameSync(tmp, target);
          };
          writeAtomic(runtimePath, out.outputText);
          writeAtomic(bootstrapPath, CHILD_BOOTSTRAP);
          writeAtomic(stampPath, stamp);
        }
        return { runtimePath, bootstrapPath, webRoot, workDir: join(dir, 'work') };
      } catch {
        return null;
      }
    })();
  }
  return runtimePromise;
}

function frozenResult(bytes: Uint8Array, mediaType: string, lastStage: string | null): ScrubResult {
  return {
    bytes,
    media_type: mediaType,
    masked: 0,
    notes: [],
    blocked: {
      reason:
        'The local SSN scan froze while reading this document' +
        (lastStage ? ` (stuck at: ${lastStage})` : '') +
        ' and was shut down, so the upload was refused rather than sending an unscanned document. The other files in your batch are unaffected.',
      instructions:
        'Try uploading this document as a PNG or JPEG image (print/screenshot it to an image), or split a long PDF into single pages. If it keeps failing, black out the SSN yourself before uploading — TaxFS never needs it.',
    },
  };
}

/**
 * Scrub one document in an isolated, killable child process. This is the
 * ONLY entry point the upload path may use: in-process scrubbing can be
 * wedged by a frozen PDF library beyond any timer's reach, and inside the
 * bundled server it cannot resolve tesseract's worker at all.
 */
export async function scrubDocumentSafely(bytes: Uint8Array, mediaType: string): Promise<ScrubResult> {
  const rt = await prepareRuntime();
  if (!rt) {
    // No isolated runtime means no real node_modules next to us — which is
    // exactly the situation where an in-process scrub ALSO cannot resolve
    // tesseract's worker, and would take the whole server down with an
    // uncaughtException instead of failing one upload. Refuse honestly.
    return {
      bytes,
      media_type: mediaType,
      masked: 0,
      notes: [],
      blocked: {
        reason:
          'The local SSN scanner could not be started on this machine, so the upload was refused rather than storing an unscanned document.',
        instructions:
          'Run "pnpm install" in the TaxFS folder and start it again. Nothing was stored, and no other document was affected.',
      },
    };
  }

  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = join(rt.workDir, `${id}.in`);
  const outFile = join(rt.workDir, `${id}.out`);
  try {
    writeFileSync(inFile, Buffer.from(bytes));
    const child = spawn(process.execPath, [rt.bootstrapPath, rt.runtimePath, inFile, mediaType, outFile], {
      cwd: rt.webRoot,
      env: { ...process.env, TAXFS_SCRUB_TRACE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    });
    const lastStage = (): string | null => {
      const m = stderrTail.match(/\[scrub\] ([^\n]*)/g);
      return m ? m[m.length - 1]!.replace('[scrub] ', '').trim() : null;
    };

    const exit = await new Promise<{ code: number | null; killed: boolean }>((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL'); // works even against frozen native/WASM code
      }, scrubBudgetMs() + killGraceMs());
      child.on('error', () => {
        clearTimeout(killer);
        resolve({ code: -1, killed: false });
      });
      child.on('exit', (code, signal) => {
        clearTimeout(killer);
        resolve({ code, killed: signal === 'SIGKILL' });
      });
    });

    if (exit.killed) return frozenResult(bytes, mediaType, lastStage());
    if (exit.code !== 0 || !existsSync(outFile)) {
      return {
        bytes,
        media_type: mediaType,
        masked: 0,
        notes: [],
        blocked: {
          reason: `The local SSN scan could not complete (the scan process ended unexpectedly${lastStage() ? ` at: ${lastStage()}` : ''}), so the upload was refused rather than sending an unscanned document.`,
          instructions:
            'Try uploading the document as a PNG or JPEG image (or split a long PDF into single pages). If it keeps failing, black out the SSN yourself before uploading — TaxFS never needs it.',
        },
      };
    }
    const meta = JSON.parse(readFileSync(outFile, 'utf8')) as {
      media_type: string;
      masked: number;
      notes: string[];
      blocked: { reason: string; instructions: string } | null;
    };
    return {
      bytes: new Uint8Array(readFileSync(`${outFile}.bin`)),
      media_type: meta.media_type,
      masked: meta.masked,
      notes: meta.notes,
      ...(meta.blocked ? { blocked: meta.blocked } : {}),
    };
  } finally {
    for (const f of [inFile, outFile, `${outFile}.bin`]) rmSync(f, { force: true });
  }
}
