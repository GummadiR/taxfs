/**
 * Audit readiness (TaxOS workstream F, ported) — being ready IF a letter
 * ever comes, NOT a prediction of audit odds (nobody can honestly predict
 * those, and TaxFS refuses to pretend). Gate-5 informational findings with
 * acknowledgment (H.2 compellability copy verbatim), and the Defense File
 * assembled entirely from existing structures.
 */
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { ACK_COPY, acknowledgeFinding, getRisk } from '@/server/risk';
import { Severity } from '@/components/badges';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

async function ackAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  await acknowledgeFinding(userId, ws.workspace_id, String(formData.get('finding_id') ?? ''));
  redirect('/risk');
}

export default async function Risk() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const dto = await getRisk(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="text-xl font-black">Audit Readiness</h1>
      <PageHelp
        what={'Being ready IF a letter ever comes — NOT a prediction of your audit odds (nobody can honestly predict those, and TaxFS refuses to pretend). Informational pattern checks plus the Defense File: your evidence, pre-assembled.'}
        doThis={[
          'Read each informational item; fix what has a fix, acknowledge what you have reviewed.',
          'After locking a package on File It, download the Defense File — the bundle you would hand a preparer if a letter came.',
        ]}
      />
      <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="risk-overview">{dto.overview}</p>

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
                <p className="mt-2 text-xs font-semibold text-emerald-700" data-testid="ack-done">Acknowledged — recorded in the platform ledger.</p>
              ) : (
                <form action={ackAction} className="mt-2">
                  <input type="hidden" name="finding_id" value={item.finding_id} />
                  <SubmitButton className="rounded border border-slate-400 px-2 py-1 text-xs" data-testid={`ack-${item.finding_id}`}>
                    Acknowledge (I have reviewed this)
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
