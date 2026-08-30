/**
 * Audit readiness (TaxOS workstream F, ported) — being ready IF a letter
 * ever comes, NOT a prediction of audit odds (nobody can honestly predict
 * those, and TaxFS refuses to pretend). Gate-5 informational findings with
 * acknowledgment (H.2 compellability copy verbatim), and the Defense File
 * assembled entirely from existing structures.
 */
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { ACK_COPY, ACK_PHRASE, acknowledgeFinding, getRisk } from '@/server/risk';
import { Severity } from '@/components/badges';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

async function ackAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const refused = await acknowledgeFinding(userId, ws.workspace_id, {
    findingId: String(formData.get('finding_id') ?? ''),
    typed: String(formData.get('typed') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  // A refusal comes back as its reason, so the operator can fix it in place
  // rather than meeting a stack trace.
  redirect(refused ? `/risk?msg=${encodeURIComponent(refused)}` : '/risk');
}

export default async function Risk({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const dto = await getRisk(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="text-xl font-black">Audit Readiness</h1>
      <PageHelp
        what={'Being ready IF a letter ever comes — NOT a prediction of your audit odds (nobody can honestly predict those, and this tool will not pretend to). It reviews your return for patterns that public IRS statistics show draw more attention — round-number estimates, deductions far above the norm for similar returns, positions with weak legal authority — and makes sure each one is DOCUMENTED before you file. The Defense File is the bundle you would hand over in response to a letter. Nothing on this page blocks filing.'}
        doThis={[
          'Read each informational item; fix what has a fix, acknowledge what you have reviewed.',
          'After locking a package on File It, download the Defense File — the bundle you would hand a preparer if a letter came.',
        ]}
      />
      <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="risk-overview">{dto.overview}</p>
      {msg ? (
        <p role="status" data-testid="risk-msg"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">{msg}</p>
      ) : null}

      {dto.items.length > 0 ? (
        <ul className="space-y-3" data-testid="risk-items">
          {dto.items.map((item) => (
            <li key={item.finding_id} className="rounded border border-slate-200 bg-white p-3 text-sm" data-testid={`risk-${item.finding_id}`}>
              <div className="flex items-center gap-2">
                <Severity severity={item.severity} />
                <span className="font-mono text-xs text-slate-500">{item.finding_id}</span>
              </div>
              <p className="mt-1 text-xs">{item.message}</p>
              {item.acknowledged ? (
                <div className="mt-2 rounded bg-emerald-50 p-2" data-testid="ack-done">
                  <p className="text-xs font-semibold text-emerald-800">
                    Acknowledged — recorded in the platform ledger{item.ack_at ? ` on ${item.ack_at.slice(0, 10)}` : ''}.
                  </p>
                  {item.ack_note ? (
                    <p className="mt-1 text-xs text-slate-700" data-testid={`ack-note-shown-${item.critic_id}`}>
                      <span className="font-semibold">Your reasoning: </span>{item.ack_note}
                    </p>
                  ) : null}
                </div>
              ) : (
                /* The ledger's own rule, made visible: a compelled record
                   showing documented reasoning defends; one showing bare
                   clicks convicts. So the reasoning box and the typed phrase
                   are the acknowledgment — not a button. */
                <form action={ackAction} className="mt-2 space-y-1.5 rounded bg-slate-50 p-2">
                  <input type="hidden" name="finding_id" value={item.finding_id} />
                  <label className="block text-xs font-semibold" htmlFor={`note-${item.finding_id}`}>
                    Your reasoning{item.note_required ? ' (required for this item — weak authority)' : ' (encouraged)'} —
                    a compelled ledger showing documented reasoning defends; a bare click does not
                  </label>
                  <textarea id={`note-${item.finding_id}`} name="note" rows={2}
                    className="w-full rounded border border-slate-300 p-1 text-xs"
                    data-testid={`ack-note-${item.critic_id}`} />
                  <label className="block text-xs font-semibold" htmlFor={`typed-${item.finding_id}`}>
                    Type “{ACK_PHRASE}” to record that you reviewed this item
                  </label>
                  <input id={`typed-${item.finding_id}`} name="typed" autoComplete="off"
                    className="w-48 rounded border border-slate-300 p-1 font-mono text-xs"
                    data-testid={`ack-input-${item.critic_id}`} />
                  <SubmitButton className="ml-2 rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white"
                    data-testid={`ack-${item.critic_id}`} pendingText="Recording…">
                    Record acknowledgment
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-slate-700" data-testid="ack-copy">{ACK_COPY}</p>

      <section className="rounded border border-slate-200 bg-white p-3 text-sm" data-testid="defense-section">
        <h2 className="font-bold">Defense File</h2>
        <p className="mt-1 text-xs text-slate-600">
          Assembled ENTIRELY from existing structures — the locked package, the neutral gate log, the
          substantiation index, transcript reconciliation, position memos, and every substantiation-complete
          capture record. Zero manual entry.
        </p>
        {dto.defense_available ? (
          <a className="mt-2 inline-block rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white" href="/api/defense" data-testid="defense-download">
            Download Defense File (JSON bundle)
          </a>
        ) : (
          <p className="mt-2 text-xs text-slate-500" data-testid="defense-unavailable">
            Lock a package on File It first — the Defense File is versioned per package version.
          </p>
        )}
      </section>
    </main>
  );
}
