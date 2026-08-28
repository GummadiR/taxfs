/**
 * Stored documents — the SCRUBBED bytes only (the redacted copy is the
 * artifact of record; no store ever holds an SSN, P15).
 *
 * Two backends behind one interface, chosen by deployment mode:
 *  - LOCAL OPERATOR: the filesystem under .taxfs-docs/ (gitignored) —
 *    "your data is on your machine" includes the documents. Refs are
 *    localfs://<workspace>/<year>/<file>.
 *  - HOSTED: the 'documents' bucket AS THE AUTHENTICATED USER — the 0002
 *    policies scope every object to workspace membership, and the object
 *    name {workspace_id}/{tax_year}/... is exactly the shape those
 *    policies (and Reset/Delete's cleanup) bind to. The service-role key
 *    never appears on request paths (Blueprint §4 (f)).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { localOperatorMode } from './env';
import { supabaseServer } from '@/lib/supabase/server';

const LOCAL_PREFIX = 'localfs://';
const BUCKET = 'documents';

function localRoot(): string {
  return process.env.TAXFS_DOCS_DIR ?? join(process.cwd(), '..', '..', '.taxfs-docs');
}

/** Resolve a localfs ref to an absolute path, refusing traversal. */
function localPathOf(rawRef: string): string {
  const rel = rawRef.slice(LOCAL_PREFIX.length);
  // turbopackIgnore: the docs dir is runtime-configured (TAXFS_DOCS_DIR) and
  // never part of the build output; without the ignore, Turbopack traces the
  // whole project into the server bundle.
  const abs = normalize(join(/* turbopackIgnore: true */ localRoot(), rel));
  if (!abs.startsWith(normalize(localRoot()) + sep)) throw new Error('invalid document ref');
  return abs;
}

export async function storeDocument(
  workspaceId: string,
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const scoped = `${workspaceId}/${objectPath}`;
  if (localOperatorMode()) {
    const abs = localPathOf(`${LOCAL_PREFIX}${scoped}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    return `${LOCAL_PREFIX}${scoped}`;
  }
  const supabase = await supabaseServer();
  if (!supabase) throw new Error('document storage is not configured in this deployment');
  const { error } = await supabase.storage.from(BUCKET).upload(scoped, bytes.slice().buffer as ArrayBuffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`document upload failed: ${error.message}`);
  // Hosted refs are the bare object name — the shape 0002's policies and
  // the Reset/Delete bucket cleanup already understand.
  return scoped;
}

export async function fetchDocument(rawRef: string): Promise<Uint8Array | null> {
  if (rawRef.startsWith(LOCAL_PREFIX)) {
    const abs = localPathOf(rawRef);
    return existsSync(abs) ? new Uint8Array(readFileSync(abs)) : null;
  }
  const supabase = await supabaseServer();
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(rawRef);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** Delete a stored document; a no-op for refs that never were stored files. */
export async function deleteDocument(rawRef: string): Promise<void> {
  if (rawRef.startsWith(LOCAL_PREFIX)) {
    const abs = localPathOf(rawRef);
    rmSync(abs, { force: true });
    return;
  }
  if (/^ws_[a-z0-9]+\//.test(rawRef)) {
    const supabase = await supabaseServer();
    if (supabase) await supabase.storage.from(BUCKET).remove([rawRef]);
  }
}

export function isStoredDocumentRef(rawRef: string): boolean {
  return rawRef.startsWith(LOCAL_PREFIX) || /^ws_[a-z0-9]+\//.test(rawRef);
}
