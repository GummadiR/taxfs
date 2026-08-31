/**
 * What a document's `raw_ref` means — pure string logic, deliberately free of
 * any dependency.
 *
 * This lived in docstore.ts, which reaches for the Supabase client and the
 * filesystem. Anything wanting only to ASK "is there a stored file behind this
 * source?" had to drag a storage backend in with it, which is why the first
 * unit test of the re-scan lifecycle failed to load at all.
 */

/** Local-operator storage. Hosted refs are bucket-relative: `ws_<id>/...`. */
export const LOCAL_PREFIX = 'localfs://';

/** True when a real file is stored behind this ref (local disk or bucket). */
export function isStoredDocumentRef(rawRef: string): boolean {
  return rawRef.startsWith(LOCAL_PREFIX) || /^ws_[a-z0-9]+\//.test(rawRef);
}

/**
 * Human-readable name for a stored upload, recovered from the storage path
 * (`.../<year>/doc-<uuid>-<safeName>`). Lets documents uploaded before
 * `__filename` was recorded still show as "Temple_Donations.pdf" instead of
 * a bare doc id. Returns null for demo/manual/unrecognized refs.
 */
export function documentDisplayName(rawRef: string): string | null {
  if (!isStoredDocumentRef(rawRef)) return null;
  const base = rawRef.split('/').pop() ?? '';
  const stripped = base.replace(/^doc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, '');
  return stripped && stripped !== base ? stripped : null;
}
