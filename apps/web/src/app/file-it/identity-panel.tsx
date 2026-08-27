'use client';
/**
 * The identity panel — everything here stays in the BROWSER (§5). Values go
 * to the encrypted IndexedDB vault and into PDFs at download time; no form
 * here ever posts to the server, and the server has no field to receive an
 * SSN anyway (G9). Testers: SYNTHETIC identities only (operator decision).
 */
import { useState } from 'react';
// Client-safe subpath: the forms barrel reaches node:fs (template
// loading) and must never enter a browser chunk.
import { fillIdentity, type FilingIdentity } from '@taxfs/forms/identity';
import { loadIdentity, saveIdentity } from '@/lib/identity/vault';

interface PdfRef {
  package_id: string;
  artifact_id: string;
  form_id: string;
  label: string;
}

export function IdentityPanel({ workspaceId, pdfs }: { workspaceId: string; pdfs: PdfRef[] }) {
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<string>('');
  const [id, setId] = useState<FilingIdentity>({ taxpayer: {} });

  const patch = (path: 'taxpayer' | 'spouse', field: string, value: string | boolean) =>
    setId((prev) => ({ ...prev, [path]: { ...(prev[path] ?? {}), [field]: value === '' ? undefined : value } }));

  async function onSave() {
    if (!passphrase) return setStatus('Enter a passphrase first.');
    await saveIdentity(workspaceId, passphrase, id);
    setStatus('Saved to this browser (encrypted).');
  }

  async function onLoad() {
    if (!passphrase) return setStatus('Enter a passphrase first.');
    try {
      const loaded = await loadIdentity(workspaceId, passphrase);
      if (!loaded) return setStatus('No identity stored in this browser for this workspace.');
      setId(loaded);
      setStatus('Loaded.');
    } catch {
      setStatus('Wrong passphrase (decryption failed) — nothing was loaded.');
    }
  }

  async function download(ref: PdfRef, withIdentity: boolean) {
    setStatus(`Fetching ${ref.label}…`);
    const res = await fetch(`/api/artifact?package_id=${encodeURIComponent(ref.package_id)}&artifact_id=${encodeURIComponent(ref.artifact_id)}`);
    if (!res.ok) return setStatus(`Download failed: ${await res.text()}`);
    let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await res.arrayBuffer());
    if (withIdentity) {
      try {
        bytes = new Uint8Array(await fillIdentity(bytes, ref.form_id, id));
      } catch (e) {
        // LOUD (the P92 lesson): never hand out a return with a silently
        // empty box because a value failed to land.
        return setStatus(`Identity fill failed: ${(e as Error).message}`);
      }
    }
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ref.form_id}${withIdentity ? '' : '-identity-blank'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`${ref.label} downloaded${withIdentity ? ' with identity filled in this browser' : ' (identity blank)'}.`);
  }

  const person = (path: 'taxpayer' | 'spouse', label: string) => (
    <fieldset className="rounded border border-slate-200 p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600">{label}</legend>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <input placeholder="First name" data-testid={`${path}-first`} value={id[path]?.first_name ?? ''}
          onChange={(e) => patch(path, 'first_name', e.target.value)} className="rounded border border-slate-300 p-1.5" />
        <input placeholder="Last name" data-testid={`${path}-last`} value={id[path]?.last_name ?? ''}
          onChange={(e) => patch(path, 'last_name', e.target.value)} className="rounded border border-slate-300 p-1.5" />
        <input placeholder="SSN (with dashes)" data-testid={`${path}-ssn`} value={id[path]?.ssn ?? ''}
          onChange={(e) => patch(path, 'ssn', e.target.value)} className="rounded border border-slate-300 p-1.5" />
        <input type="date" data-testid={`${path}-dob`} value={id[path]?.dob ?? ''}
          onChange={(e) => patch(path, 'dob', e.target.value)} className="rounded border border-slate-300 p-1.5" />
      </div>
    </fieldset>
  );

  return (
    <section className="mt-8 rounded border border-slate-300 p-4" data-testid="identity-panel">
      <h2 className="font-bold">Identity — stays in this browser</h2>
      <p className="mt-1 text-xs text-slate-600">
        Names, SSNs and birth dates never reach the server: they are encrypted with your passphrase
        (Argon2id → AES-256-GCM) into this browser&apos;s storage, and printed into the PDFs on your machine at
        download time. Testers: synthetic identities only.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input type="password" placeholder="Passphrase" data-testid="identity-passphrase" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} className="rounded border border-slate-300 p-1.5 text-sm" />
        <button onClick={onSave} className="rounded border border-slate-300 px-2 py-1 text-sm" data-testid="identity-save">Save</button>
        <button onClick={onLoad} className="rounded border border-slate-300 px-2 py-1 text-sm" data-testid="identity-load">Load</button>
        <span className="text-xs text-slate-500" data-testid="identity-status">{status}</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {person('taxpayer', 'Taxpayer')}
        {person('spouse', 'Spouse (joint returns)')}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-sm">
        <input placeholder="Street address" data-testid="identity-address" value={id.address_line ?? ''}
          onChange={(e) => setId((p) => ({ ...p, address_line: e.target.value || undefined }))}
          className="col-span-2 rounded border border-slate-300 p-1.5" />
        <input placeholder="City" data-testid="identity-city" value={id.city ?? ''}
          onChange={(e) => setId((p) => ({ ...p, city: e.target.value || undefined }))}
          className="rounded border border-slate-300 p-1.5" />
        <div className="flex gap-2">
          <input placeholder="ST" value={id.state ?? ''}
            onChange={(e) => setId((p) => ({ ...p, state: e.target.value || undefined }))}
            className="w-12 rounded border border-slate-300 p-1.5" />
          <input placeholder="ZIP" value={id.zip ?? ''}
            onChange={(e) => setId((p) => ({ ...p, zip: e.target.value || undefined }))}
            className="flex-1 rounded border border-slate-300 p-1.5" />
        </div>
      </div>
      {pdfs.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Print-ready downloads (filled in this browser)</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {pdfs.map((ref) => (
              <span key={ref.artifact_id} className="flex gap-1">
                <button onClick={() => download(ref, true)} data-testid={`download-${ref.form_id}`}
                  className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">
                  {ref.label} + identity
                </button>
                <button onClick={() => download(ref, false)} data-testid={`download-blank-${ref.form_id}`}
                  className="rounded border border-slate-300 px-2 py-1.5 text-xs">
                  blank
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">Lock a package to enable downloads.</p>
      )}
    </section>
  );
}
