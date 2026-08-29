import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { UploadDropzone } from '@/components/upload-dropzone';
import { deleteUploadedDocument, rescanDocument } from '@/server/upload';
import { documentDisplayName, isStoredDocumentRef } from '@/server/docstore';
import { withSpine } from '@/server/db';
import { DEMO_DOCS, MANUAL_CONCEPTS, addDemoDoc, addManualEntry } from '@/server/demo-docs';
import { withUserClient } from '@/server/db';
import { takeBudget } from '@/server/limits';
import { TAX_YEAR } from '@/server/env';

async function addDemo(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const doc = DEMO_DOCS.find((d) => d.id === String(formData.get('doc')));
  if (!doc) throw new Error('unknown demo document');
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'intake'));
  await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) => addDemoDoc(spine, ws.workspace_id, doc));
  redirect('/review');
}

async function addManual(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const concept = String(formData.get('concept'));
  const amount = String(formData.get('amount') ?? '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) throw new Error('amount must be a plain dollar figure like 1234.56');
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'intake'));
  await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    addManualEntry(spine, ws.workspace_id, concept, amount));
  redirect('/review');
}

async function removeDoc(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const source_id = String(formData.get('source_id'));
  // Stored uploads also remove their file; demo/manual sources have none.
  const msg = await deleteUploadedDocument(userId, ws.workspace_id, source_id);
  redirect(`/documents?msg=${encodeURIComponent(msg)}`);
}

async function rescanDoc(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'upload'));
  const report = await rescanDocument(userId, ws.workspace_id, String(formData.get('source_id')));
  redirect(`/documents?msg=${encodeURIComponent(report.messages.join(' '))}`);
}

export default async function Documents({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const sources = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    spine.getSources(ws.workspace_id, TAX_YEAR));
  return (
    <main>
      <h1 className="text-xl font-black">Documents</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your evidence locker. Upload tax documents (W-2, 1099s, K-1, 1095-A, brokerage statements) — every file
        is scrubbed of SSNs ON THIS MACHINE before storage or reading (a document that cannot be safely scrubbed
        is refused), and every extracted value still needs your confirmation on Review before it counts.
      </p>
      {msg ? <p className="mt-2 rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="docs-msg">{msg}</p> : null}
      <div className="mt-4">
        <UploadDropzone />
      </div>
      <ul className="mt-4 space-y-2" data-testid="source-list">
        {sources.map((s) => {
          // The operator's own file name (exact for new uploads via __filename;
          // recovered from the storage path for older ones). The doc id stays
          // available on hover — it is a database key, not a display name.
          const docName = s.fields['__filename'] ?? documentDisplayName(s.raw_ref);
          return (
          <li key={s.source_id} className="flex items-center justify-between rounded border border-slate-200 p-3 text-sm">
            <span>
              <span className="font-semibold">{s.type}</span>
              {docName ? (
                <span className="ml-2" title={s.source_id} data-testid={`docname-${s.source_id}`}>{docName}</span>
              ) : (
                <span className="ml-2 text-xs text-slate-500">{s.source_id}</span>
              )}
              <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${s.review_status === 'confirmed' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
                {s.review_status}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {isStoredDocumentRef(s.raw_ref) ? (
                <form action={rescanDoc}>
                  <input type="hidden" name="source_id" value={s.source_id} />
                  <button className="text-xs underline" data-testid={`rescan-${s.source_id}`}
                    title="Re-read the stored file (P26): its unconfirmed values are rebuilt from the same scrubbed bytes.">
                    Rescan
                  </button>
                </form>
              ) : null}
              <form action={removeDoc}>
                <input type="hidden" name="source_id" value={s.source_id} />
                <button className="text-xs text-red-700 underline">Remove</button>
              </form>
            </span>
          </li>
          );
        })}
        {sources.length === 0 ? <li className="text-sm text-slate-500">No documents yet.</li> : null}
      </ul>
      <section className="mt-6">
        <h2 className="font-bold">Add a demo document</h2>
        <div className="mt-2 flex gap-2">
          {DEMO_DOCS.map((d) => (
            <form key={d.id} action={addDemo}>
              <input type="hidden" name="doc" value={d.id} />
              <button className="rounded border border-slate-300 px-3 py-2 text-sm" data-testid={`add-${d.id}`}>{d.label}</button>
            </form>
          ))}
        </div>
      </section>
      <section className="mt-6">
        <h2 className="font-bold">Typed entry</h2>
        <form action={addManual} className="mt-2 flex gap-2">
          <select name="concept" className="rounded border border-slate-300 p-2 text-sm" data-testid="manual-concept">
            {MANUAL_CONCEPTS.map((c) => <option key={c.concept} value={c.concept}>{c.label}</option>)}
          </select>
          <input name="amount" required placeholder="Amount" inputMode="decimal"
            className="w-32 rounded border border-slate-300 p-2 text-sm" data-testid="manual-amount" />
          <button className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Add</button>
        </form>
      </section>
    </main>
  );
}
