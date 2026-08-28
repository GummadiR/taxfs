import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { getInterview, recordAttestation } from '@/server/interview';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

async function answerAttestation(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const concept = String(formData.get('concept') ?? '');
  const answer = String(formData.get('answer') ?? '');
  if (!concept || (answer !== 'yes' && answer !== 'no')) throw new Error('concept and a yes/no answer are required');
  await recordAttestation(userId, ws.workspace_id, concept, answer);
  redirect('/interview');
}

export default async function Interview() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const dto = await getInterview(userId, ws.workspace_id);
  return (
    <main className="max-w-2xl space-y-4">
      <h1 className="text-xl font-black">Interview</h1>
      <PageHelp
        what={'The gap interview: TaxFS asks only what the documents could not answer (e.g. the Illinois residency attestation). Questions come from registered templates — it never free-styles tax advice.'}
        doThis={[
          'Answer each question; attestations are recorded with your exact words.',
          'When there are no open questions, move on to Review or the Gates Board.',
        ]}
      />
      <p className="text-sm text-slate-600">
        Questions come from the deterministic gap report — the system decides <em>what</em> is needed; the assistant only
        phrases and orders it. Every question tells you why it is asked.
      </p>
      {dto.needs_setup ? (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="interview-needs-setup">
          Complete <a className="underline" href="/get-started">Get Started</a> first — the gap report reads your filing choices.
        </p>
      ) : dto.questions.length === 0 ? (
        <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm" data-testid="interview-empty">
          No open questions right now. New documents or edits can re-open gaps.
        </p>
      ) : (
        <ol className="space-y-3">
          {dto.questions.map((q) => (
            <li
              key={q.question_id}
              data-testid={`question-${q.why_asked}`}
              className={
                q.attestation
                  ? 'rounded border-2 border-indigo-400 bg-indigo-50 p-3 text-sm'
                  : 'rounded border border-slate-200 bg-white p-3 text-sm'
              }
            >
              {q.attestation ? (
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-indigo-700" data-testid="attestation-banner">
                  Formal determination — your answer is recorded as a dated attestation
                </p>
              ) : null}
              <p className="font-semibold">{q.text}</p>
              <p className="mt-1 text-xs text-slate-500" data-testid="why-asked">
                Why we ask: {q.why_detail}
              </p>
              {q.attestation ? (
                <form action={answerAttestation} className="mt-2 flex gap-2">
                  <input type="hidden" name="concept" value={q.maps_to_concept} />
                  <SubmitButton name="answer" value="yes" className="rounded bg-slate-900 px-3 py-1 text-white" data-testid="attest-yes">
                    Yes
                  </SubmitButton>
                  <SubmitButton name="answer" value="no" className="rounded border border-slate-400 px-3 py-1" data-testid="attest-no">
                    No
                  </SubmitButton>
                </form>
              ) : (
                <p className="mt-2 text-xs text-slate-500">Handle this on the Documents page, then come back.</p>
              )}
              <details className="mt-2 text-xs text-slate-500">
                <summary className="cursor-pointer">Skip for now?</summary>
                <p data-testid="defer-consequence">
                  You can defer this, but the gate that needs it stays open and filing remains blocked until it is answered
                  or the underlying document arrives.
                </p>
              </details>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
