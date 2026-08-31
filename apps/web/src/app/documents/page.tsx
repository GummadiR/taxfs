import { SubmitButton } from '@/components/submit-button';
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { UploadDropzone } from '@/components/upload-dropzone';
import { deleteUploadedDocument, rescanDocument } from '@/server/upload';
import { documentDisplayName } from '@/server/docstore';
import { warmScrubber } from '@/server/scrub';
import { PageHelp } from '@/components/pagehelp';
import { withSpine } from '@/server/db';
import { DEMO_DOCS, MANUAL_CONCEPTS, addDemoDoc, addManualEntry } from '@/server/demo-docs';
import { withUserClient } from '@/server/db';
import { takeBudget } from '@/server/limits';
import { TAX_YEAR } from '@/server/env';
import { pendingConfirmations, rescanState, sourceTitle, valuesBySource, TYPE_TO_VERIFY_BELOW } from '@/server/confirmations';
import { Origin } from '@/components/badges';

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

/**
 * Confirm one extracted value (G8). For a low-confidence reading the operator
 * must TYPE what they read — TaxOS's rule, and the reason it exists: clicking
 * "confirm" on a number you never looked at is not confirmation.
 */
async function confirmValue(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const fact_id = String(formData.get('fact_id'));
  const typed = String(formData.get('typed_value') ?? '').trim();
  const expected = String(formData.get('expected_value') ?? '').trim();
  if (formData.get('type_to_verify') === '1') {
    if (typed === '') {
      redirect(`/documents?msg=${encodeURIComponent('Type the value you read on the document to confirm it — nothing was changed.')}`);
    }
    if (Number(typed) !== Number(expected)) {
      redirect(`/documents?msg=${encodeURIComponent(`You typed ${typed} but the reader saw ${expected}. Nothing was confirmed — check the document, and use Typed entry if the reader is wrong.`)}`);
    }
  }
  const source_id = String(formData.get('source_id') ?? '');
  await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
    await spine.confirmFact(fact_id);
    if (source_id) {
      const facts = await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR });
      const remaining = facts.filter(
        (f) => f.provenance?.some((pr) => pr.source_id === source_id) && f.status !== 'confirmed' && f.fact_id !== fact_id,
      );
      if (remaining.length === 0) await spine.confirmSource(source_id);
    }
  });
  redirect(`/documents?msg=${encodeURIComponent('Value confirmed — it now counts toward your return.')}`);
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
  const sourceId = String(formData.get('source_id'));
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'upload'));
  const report = await rescanDocument(userId, ws.workspace_id, sourceId);
  // Report back ON THE ROW that was clicked, and anchor to it. The answer used
  // to land in a banner at the top of the page while the button was ten rows
  // down — so a re-scan looked like it had done nothing at all.
  redirect(`/documents?msg=${encodeURIComponent(report.messages.join(' '))}&row=${encodeURIComponent(sourceId)}#src-${encodeURIComponent(sourceId)}`);
}

/** Re-scan every document that can actually be re-read, in one pass. */
async function rescanAll() {
  'use server';
  const { userId, ws } = await requireContext();
  const { sources, facts } = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => ({
    sources: await spine.getSources(ws.workspace_id, TAX_YEAR),
    facts: await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }),
  }));
  const targets = sources.filter((s) => rescanState(s, facts).canRescan);
  const done: string[] = [];
  for (const s of targets) {
    await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'upload'));
    const report = await rescanDocument(userId, ws.workspace_id, s.source_id);
    done.push(report.messages.join(' '));
  }
  const summary = targets.length === 0
    ? 'No document needed re-scanning — every stored file has already been read and confirmed.'
    : `Re-scanned ${targets.length} document(s). ${done.join(' ')}`;
  redirect(`/documents?msg=${encodeURIComponent(summary)}`);
}

export default async function Documents({ searchParams }: { searchParams: Promise<{ msg?: string; row?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  // Start loading the OCR engine now, in the background: by the time files
  // are picked, the first document skips the ~23 MB model cold start.
  warmScrubber();
  const { msg, row } = await searchParams;
  const { sources, facts } = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => ({
    sources: await spine.getSources(ws.workspace_id, TAX_YEAR),
    facts: await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }),
  }));
  const pending = pendingConfirmations(facts, sources);
  const rescanable = sources.filter((s) => rescanState(s, facts).canRescan);
  const bySource = valuesBySource(facts);
  return (
    <main>
      <h1 className="text-xl font-black">Documents</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your evidence locker. Upload tax documents (W-2, 1099s, K-1, 1095-A, brokerage statements) — every file
        is scrubbed of SSNs ON THIS MACHINE before storage or reading (a document that cannot be safely scrubbed
        is refused), and every extracted value still needs your confirmation on Review before it counts.
      </p>
      <div className="mt-3">
        <PageHelp
          what={'Your evidence locker. Upload tax documents (W-2, 1099s, K-1, 1095-A, brokerage statements) — every file is scrubbed of SSNs on this machine before storage or reading, and every extracted value still needs your confirmation on Review before it counts. Amounts with no scannable document go in Typed entry.'}
          doThis={[
            'Upload each document (image or PDF). Duplicates are refused automatically by content fingerprint.',
            'Use Typed entry for amounts without a scannable form (solar cost, estimated payments, foreign bank interest…).',
            'Most documents never need re-scanning. Rescan appears only where a stored file has values you have not confirmed yet — extraction was off, it failed, or you have not accepted the reading. Once you confirm a value, the document is done and the button goes away.',
            'Remove deletes a document and everything computed from it, and is how you start a document over.',
          ]}
        />
      </div>
      <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900" data-testid="scrub-notice">
        Privacy, honestly stated: SSNs are blacked out ON THIS MACHINE before a document is stored or read — a
        page whose text carries the number is re-rendered to pixels so it is destroyed, not covered, and the
        rebuilt file is verified SSN-free before it is accepted. Two honest caveats: a page image that cannot be
        decoded locally is reported as unscanned rather than assumed clean, and a document that cannot be safely
        scrubbed is refused with instructions rather than stored as-is.
      </p>
      {msg && !row ? <p className="mt-2 rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="docs-msg">{msg}</p> : null}
      <div className="mt-4">
        <UploadDropzone />
      </div>
      {pending.length > 0 ? (
        <section className="mt-6 rounded border border-sky-300 bg-sky-50/40 p-4" data-testid="confirm-panel">
          <h2 className="font-bold">Review — nothing counts until you confirm it</h2>
          <p className="mt-1 text-xs text-slate-600">
            {pending.length} value{pending.length === 1 ? '' : 's'} read from your documents are waiting. Each one
            shows the document and the box it came from, and how sure the reader was — check it against the paper
            before you confirm. A low-confidence reading must be TYPED, not clicked.
          </p>
          <div className="mt-3 space-y-2">
            {pending.map((p) => (
              <div key={p.fact_id} className="rounded border border-slate-200 bg-white p-3 text-sm"
                data-testid={`pending-${p.fact_id}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold">{p.label}</span>
                  <span className="font-mono text-base">{p.value}</span>
                  <Origin origin={p.machine_read ? 'scanned' : 'manual'} />
                  {p.machine_read ? (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-800"
                      data-testid="ai-marker">
                      read by machine — confirm before it counts
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {p.doc_title ? <>from <span className="font-semibold">{p.doc_title}</span></> : 'entered by you'}
                  {p.source_field ? <> · box <span className="font-mono">{p.source_field}</span></> : null}
                  {p.machine_read ? <> · confidence {(p.confidence * 100).toFixed(0)}%</> : null}
                  <> · <span className="font-mono">{p.concept}</span></>
                </p>
                <form action={confirmValue} className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="fact_id" value={p.fact_id} />
                  <input type="hidden" name="source_id" value={p.source_id ?? ''} />
                  <input type="hidden" name="expected_value" value={p.value} />
                  <input type="hidden" name="type_to_verify" value={p.type_to_verify ? '1' : '0'} />
                  {p.type_to_verify ? (
                    <>
                      <label className="text-xs font-semibold" htmlFor={`typed-${p.fact_id}`}>
                        Type what YOU read on the document:
                      </label>
                      <input id={`typed-${p.fact_id}`} name="typed_value" autoComplete="off"
                        className="w-32 rounded border border-slate-300 p-1 font-mono text-sm"
                        data-testid={`typed-${p.fact_id}`} />
                    </>
                  ) : null}
                  <SubmitButton className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                    data-testid={`confirm-${p.fact_id}`} pendingText="Confirming…">
                    Confirm this value
                  </SubmitButton>
                </form>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Below {(TYPE_TO_VERIFY_BELOW * 100).toFixed(0)}% confidence the value must be typed — clicking
            &quot;confirm&quot; on a number you never looked at is not confirmation.
          </p>
        </section>
      ) : null}
      {rescanable.length > 0 ? (
        <form action={rescanAll} className="mt-4">
          <SubmitButton className="rounded border border-emerald-400 px-3 py-1.5 text-xs font-semibold text-emerald-800"
            data-testid="rescan-all" pendingText={`Re-reading ${rescanable.length} document(s)…`}>
            Re-scan the {rescanable.length} document{rescanable.length === 1 ? '' : 's'} that need it
          </SubmitButton>
        </form>
      ) : null}
      <ul className="mt-4 space-y-2" data-testid="source-list">
        {sources.map((s) => {
          // The operator's own file name (exact for new uploads via __filename;
          // recovered from the storage path for older ones). The doc id stays
          // available on hover — it is a database key, not a display name.
          const docName = s.fields['__filename']
            ?? documentDisplayName(s.raw_ref)
            ?? sourceTitle(s, bySource.get(s.source_id) ?? []);
          const st = rescanState(s, facts);
          const isTarget = row === s.source_id;
          return (
          // The anchor the lineage drawer links to (/documents#src-<id>). It
          // was missing, so "open this document" from a calculation trail
          // landed on the page and scrolled nowhere.
          <li key={s.source_id} id={`src-${s.source_id}`}
            className={`scroll-mt-4 rounded border p-3 text-sm ${isTarget ? 'border-sky-400 bg-sky-50' : 'border-slate-200'}`}>
            <div className="flex items-center justify-between">
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
                {st.nothingRead ? (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900"
                    data-testid={`nothing-read-${s.source_id}`}
                    title="The file is stored, but no values were read from it — usually because extraction was off or refused at upload. Re-scan reads the same stored bytes again.">
                    nothing read from this yet
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-2">
                {/* Only offered when it can change something. A re-scan can
                    never touch a CONFIRMED value — re-proposing on top of one
                    is how a document gets counted twice — so on a confirmed
                    document the button did nothing but print a refusal. TaxOS
                    showed it on almost no row for the same reason. */}
                {st.canRescan ? (
                  <form action={rescanDoc}>
                    <input type="hidden" name="source_id" value={s.source_id} />
                    <SubmitButton className="text-xs underline" data-testid={`rescan-${s.source_id}`}
                      pendingText="Reading…"
                      title="Read the stored file again. Only unconfirmed values are rebuilt; confirmed ones are never touched.">
                      Rescan
                    </SubmitButton>
                  </form>
                ) : (
                  <span className="text-xs text-slate-400" data-testid={`rescan-na-${s.source_id}`}
                    title={st.why}>{st.shortWhy}</span>
                )}
                <form action={removeDoc}>
                  <input type="hidden" name="source_id" value={s.source_id} />
                  <SubmitButton className="text-xs text-red-700 underline" pendingText="Removing…" data-testid={`remove-${s.source_id}`}>Remove</SubmitButton>
                </form>
              </span>
            </div>
            {isTarget && msg ? (
              <p className="mt-2 rounded bg-white p-2 text-xs text-slate-700" role="status"
                data-testid={`row-msg-${s.source_id}`}>{msg}</p>
            ) : null}
            {/* What this document actually gave your return. These used to sit
                only on Review, in one long table divorced from the documents
                that produced them, so "what did this W-2 give me?" could not
                be answered anywhere. */}
            {(bySource.get(s.source_id) ?? []).length > 0 ? (
              <table className="mt-2 w-full text-xs" data-testid={`values-${s.source_id}`}>
                <tbody>
                  {(bySource.get(s.source_id) ?? []).map((v) => (
                    <tr key={v.fact_id} className="border-t border-slate-100">
                      <td className="py-1 pr-2 text-slate-700" title={v.concept}>{v.label}</td>
                      <td className="py-1 pr-2 text-slate-400">
                        {v.field && v.field !== 'attestation' ? v.field : ''}
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{v.value}</td>
                      <td className="py-1 w-24 text-right">
                        <span className={`rounded px-1.5 py-0.5 ${
                          v.stale ? 'bg-amber-100 text-amber-900'
                          : v.confirmed ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-900'}`}>
                          {v.stale ? 'stale' : v.confirmed ? 'counts' : 'not counting yet'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-xs text-slate-400" data-testid={`no-values-${s.source_id}`}>
                No values came from this document yet.
              </p>
            )}
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
              <SubmitButton className="rounded border border-slate-300 px-3 py-2 text-sm" data-testid={`add-${d.id}`} pendingText="Adding…">{d.label}</SubmitButton>
            </form>
          ))}
        </div>
      </section>
      <section className="mt-6">
        <h2 className="font-bold">Typed entry — any amount with no scannable document</h2>
        <p className="mt-1 text-xs text-slate-600">
          Itemized deductions, foreign tax paid, tax-exempt interest, estimated payments, HSA/IRA/401(k)
          contributions, prior-year carryovers, the Form 2210 penalty. Typing a value IS its confirmation —
          it counts immediately, unlike a value read from a document.
        </p>
        <form action={addManual} className="mt-2 flex flex-wrap items-start gap-2">
          <select name="concept" className="max-w-xl rounded border border-slate-300 p-2 text-sm" data-testid="manual-concept">
            {[...new Set(MANUAL_CONCEPTS.map((c) => c.group))].map((group) => (
              <optgroup key={group} label={group}>
                {MANUAL_CONCEPTS.filter((c) => c.group === group).map((c) => (
                  <option key={c.concept} value={c.concept}>{c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <input name="amount" required placeholder="Amount" inputMode="decimal"
            className="w-32 rounded border border-slate-300 p-2 text-sm" data-testid="manual-amount" />
          <SubmitButton className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white" pendingText="Saving…">Add</SubmitButton>
        </form>
      </section>
    </main>
  );
}
