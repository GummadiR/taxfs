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
import { fillIdentity, hasIdentityLayout, incompleteIdentityMessage, missingIdentityFields, type FilingIdentity } from '@taxfs/forms/identity';
import { loadIdentity, saveIdentity } from '@/lib/identity/vault';

interface PdfRef {
  package_id: string;
  artifact_id: string;
  form_id: string;
  label: string;
}

export function IdentityPanel({ workspaceId, joint = false, pdfs }: { workspaceId: string; joint?: boolean; pdfs: PdfRef[] }) {
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<string>('');
  /** Which click is in flight — every button disables while one runs, so a
   *  slow PDF fill can never look like a dead button (or be double-clicked). */
  const [busy, setBusy] = useState<string | null>(null);
  const [id, setId] = useState<FilingIdentity>({ taxpayer: {} });

  const patch = (path: 'taxpayer' | 'spouse', field: string, value: string | boolean) =>
    setId((prev) => ({ ...prev, [path]: { ...(prev[path] ?? {}), [field]: value === '' ? undefined : value } }));

  async function onSave() {
    if (!passphrase) return setStatus('Enter a passphrase first.');
    setBusy('save');
    try {
      await saveIdentity(workspaceId, passphrase, id);
      setStatus('Saved to this browser (encrypted).');
    } finally {
      setBusy(null);
    }
  }

  async function onLoad() {
    if (!passphrase) return setStatus('Enter a passphrase first.');
    setBusy('load');
    try {
      const loaded = await loadIdentity(workspaceId, passphrase);
      if (!loaded) return setStatus('No identity stored in this browser for this workspace.');
      setId(loaded);
      setStatus('Loaded.');
    } catch {
      setStatus('Wrong passphrase (decryption failed) — nothing was loaded.');
    } finally {
      setBusy(null);
    }
  }

  async function download(ref: PdfRef, withIdentity: boolean) {
    // Refuse BEFORE fetching: regenerating and hash-verifying the artifact is
    // real work, and there is nothing to fill it with.
    if (withIdentity) {
      // Refuse a form with no Step-1 block BEFORE promising anything:
      // fillIdentity passes such a form through untouched, so without this the
      // status line would claim "identity filled" over an unwritten PDF.
      if (!hasIdentityLayout(ref.form_id)) {
        return setStatus(
          `Not downloaded — ${ref.label} has no name/SSN block, so nothing could be filled in. `
          + 'The identity-filled copies are the 1040 and IL-1040.',
        );
      }
      const missing = missingIdentityFields(id, ref.form_id, joint);
      if (missing.length > 0) return setStatus(`Not downloaded — ${incompleteIdentityMessage(missing)}`);
    }
    setBusy(`${ref.artifact_id}:${withIdentity}`);
    setStatus(`Fetching ${ref.label}…`);
    try {
    const res = await fetch(`/api/artifact?package_id=${encodeURIComponent(ref.package_id)}&artifact_id=${encodeURIComponent(ref.artifact_id)}`);
    if (!res.ok) return setStatus(`Download failed: ${await res.text()}`);
    let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await res.arrayBuffer());
    if (withIdentity) {
      try {
        bytes = new Uint8Array(await fillIdentity(bytes, ref.form_id, id, { joint }));
      } catch (e) {
        // LOUD (the P92 lesson): never hand out a return with a silently
        // empty box — whether a value FAILED to land or was never there.
        // Nothing downloads, so a blank Step 1 cannot reach a printer
        // believing it is filled.
        return setStatus(`Not downloaded — ${(e as Error).message}`);
      }
    }
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    const name = `${ref.form_id}${withIdentity ? '' : '-identity-blank'}.pdf`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    // The anchor must be IN the document: a detached one is ignored outright
    // by some browsers, so the click did nothing and the button just went
    // back to normal.
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke LATER. Revoking synchronously after click() destroys the blob
    // before the browser has finished reading it, which cancels the download
    // silently — the operator sees "Preparing…", then nothing, and no error.
    // That is what made this look like it had done nothing at all.
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      // Say the FILENAME: a download that lands in the browser's downloads
      // folder is invisible from this page, and "downloaded" alone left the
      // operator hunting for something they could not see.
      setStatus(
        `${name} saved to your browser's downloads${withIdentity ? ', with your name and SSN filled in on this machine' : ' (identity deliberately blank)'}.`,
      );
    } finally {
      setBusy(null);
    }
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
        <button onClick={onSave} disabled={busy !== null} className="rounded border border-slate-300 px-2 py-1 text-sm disabled:cursor-wait disabled:opacity-60" data-testid="identity-save">{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button onClick={onLoad} disabled={busy !== null} className="rounded border border-slate-300 px-2 py-1 text-sm disabled:cursor-wait disabled:opacity-60" data-testid="identity-load">{busy === 'load' ? 'Loading…' : 'Load'}</button>
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
          <input placeholder="ST" data-testid="identity-state" value={id.state ?? ''}
            onChange={(e) => setId((p) => ({ ...p, state: e.target.value || undefined }))}
            className="w-12 rounded border border-slate-300 p-1.5" />
          <input placeholder="ZIP" data-testid="identity-zip" value={id.zip ?? ''}
            onChange={(e) => setId((p) => ({ ...p, zip: e.target.value || undefined }))}
            className="flex-1 rounded border border-slate-300 p-1.5" />
        </div>
      </div>
      {pdfs.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Print-ready downloads (filled in this browser)</h3>
          {/* Say what is missing BEFORE the click. The panel starts empty on
              every page load — a saved identity lives encrypted in this
              browser and only comes back when you press Load — so "I printed
              it and my details were blank" was the predictable outcome. */}
          {(() => {
            // Judge readiness against the forms actually offered, not a
            // hardcoded one: only the IL-1040 face carries a date of birth,
            // so demanding it when there is no IL form to print is nagging
            // about a field nothing needs.
            const strictest = pdfs.some((p) => p.form_id === 'IL1040') ? 'IL1040' : '1040';
            const missing = missingIdentityFields(id, strictest, joint);
            return missing.length === 0 ? (
              <p className="mt-1 text-xs text-emerald-700" data-testid="identity-ready">
                Ready: your details will be printed into the forms below on this machine.
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-800" data-testid="identity-incomplete">
                <span className="font-semibold">Your details are not filled in yet</span> — the forms would print
                with a blank Step 1. Missing: {missing.join(', ')}.
                {' '}If you saved them before, enter your passphrase above and press <span className="font-semibold">Load</span>.
              </p>
            );
          })()}
          <div className="mt-2 flex flex-wrap gap-2">
            {pdfs.map((ref) => (
              <span key={ref.artifact_id} className="flex gap-1">
                <button onClick={() => download(ref, true)} data-testid={`download-${ref.form_id}`} disabled={busy !== null}
                  className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60">
                  {busy === `${ref.artifact_id}:true` ? 'Preparing…' : `${ref.label} + identity`}
                </button>
                <button onClick={() => download(ref, false)} data-testid={`download-blank-${ref.form_id}`} disabled={busy !== null}
                  className="rounded border border-slate-300 px-2 py-1.5 text-xs disabled:cursor-wait disabled:opacity-60">
                  {busy === `${ref.artifact_id}:false` ? 'Preparing…' : 'blank'}
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
