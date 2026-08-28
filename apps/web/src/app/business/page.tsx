import Link from 'next/link';
import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { getBusinessFiling, markPackagesBuilt } from '@/server/business';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

async function buildBusinessPackagesAction() {
  'use server';
  const { userId, ws } = await requireContext();
  // Determinism is the storage (same principle as artifact regeneration):
  // the flag records the operator's intent; the packages rebuild from the
  // current confirmed facts on every read, so they can never go stale.
  await markPackagesBuilt(userId, ws.workspace_id);
  redirect('/business');
}

/**
 * P13 — Business Tax Filing. Each owned entity files its OWN return
 * (S-corp → Form 1120-S; multi-member LLC / partnership → Form 1065), due
 * March 16, 2026 for calendar-year 2025 — a month BEFORE the personal
 * deadline, because the K-1s it produces feed the owners' personal returns.
 * Business e-file goes through IRS-authorized transmitters only, so the
 * package here is print-and-mail plus a K-1 copy per owner.
 */
export default async function Business() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const dto = await getBusinessFiling(userId, ws.workspace_id);
  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="text-xl font-black">Business Tax Filing</h1>
      <PageHelp
        what={'Separate returns for the businesses you own: each S-corp files Form 1120-S and each multi-member LLC/partnership files Form 1065 (plus the Illinois IL-1120-ST / IL-1065). The package includes a Schedule K-1 for every owner — hand each owner their copy; your own K-1 goes into your personal return on Add Data.'}
        doThis={[
          'Enter each entity\'s books on the Entities page (receipts, deductions, owners and their shares).',
          'Build the business package here — one per entity: the federal return, the Illinois return, and a K-1 + IL Schedule K-1-P per owner.',
          'Print, sign, and mail each entity return by March 16, 2026; give every owner their K-1, and enter YOUR K-1s on Add Data for the personal return.',
        ]}
      />
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="biz-deadline">
        <span className="font-semibold">Deadline: March 16, 2026</span> for calendar-year 2025 Forms 1120-S and
        1065 (March 15 falls on a Sunday) — one month before the personal deadline, because the K-1s produced here
        feed the owners&apos; personal returns. A single-member LLC does NOT file here: it is a disregarded entity
        reported on Schedule C inside the owner&apos;s personal return.
      </p>

      {!dto.has_entities ? (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="biz-empty">
          No business entities entered yet. Add each entity&apos;s books (and its owners with their ownership
          shares) on the <Link className="underline" href="/entities">Entities</Link> page — then build the
          per-entity filing packages here.
        </p>
      ) : dto.error ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm" data-testid="biz-error">
          The entity calculation stopped: {dto.error}
        </p>
      ) : (
        <>
          <form action={buildBusinessPackagesAction}>
            <SubmitButton className="rounded bg-slate-900 px-4 py-2 text-sm text-white" data-testid="biz-build">
              Build business filing packages
            </SubmitButton>
            <span className="ml-2 text-xs text-slate-500">
              Rebuild any time — the package always reflects the current entity data.
            </span>
          </form>

          {dto.entities.map((e) => (
            <section
              key={e.entity_id}
              className="rounded border border-slate-200 bg-white p-3 text-sm"
              data-testid={`biz-entity-${e.entity_id}`}
            >
              <h2 className="font-bold">
                {e.entity_id}{' '}
                <span className="font-normal text-slate-500">
                  — {e.scorp ? 'S corporation · Form 1120-S + IL-1120-ST' : 'Partnership / multi-member LLC · Form 1065 + IL-1065'} ·{' '}
                  {e.member_ids.length} owner{e.member_ids.length === 1 ? '' : 's'}
                </span>
              </h2>
              <table className="mt-2 text-xs">
                <tbody>
                  {e.headline.map((h) => (
                    <tr key={h.label}>
                      <td className="pr-4">{h.label}</td>
                      <td className="text-right font-mono font-bold">{h.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!e.built ? (
                <p className="mt-2 rounded bg-slate-50 p-2 text-xs" data-testid={`biz-notbuilt-${e.entity_id}`}>
                  Package not built yet — use the button above.
                </p>
              ) : (
                <>
                  {!e.built.clean ? (
                    <div className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs" data-testid={`biz-defects-${e.entity_id}`}>
                      <p className="font-semibold">This package has defects and is not filing-ready:</p>
                      <ul className="mt-1 list-disc pl-4">
                        {e.built.defects.map((d, i) => (
                          <li key={i}>{d.form_id} {d.line_id}: {d.message}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-3 space-y-3" data-testid={`biz-forms-${e.entity_id}`}>
                    {e.built.forms.map((f) => (
                      <div key={f.form_id} className="rounded border border-slate-100 p-2" data-testid={`biz-form-${e.entity_id}-${f.form_id}`}>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-xs font-bold">
                            {f.form_id}
                            {f.member_id ? (
                              <span className="ml-1 rounded bg-indigo-100 px-1 font-normal text-indigo-800">
                                owner copy: {f.member_id}
                              </span>
                            ) : null}
                            <span className="ml-1 text-slate-400">({f.jurisdiction})</span>
                            {!f.real_pdf ? (
                              <span className="ml-1 rounded bg-amber-100 px-1 font-normal text-amber-800" title="The official form PDF has not been dropped in yet — this downloads the loud placeholder rendering.">
                                placeholder — official PDF pending
                              </span>
                            ) : null}
                          </h3>
                          <a
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs underline"
                            href={`/api/bizartifact?entity=${encodeURIComponent(e.entity_id)}&artifact_id=${encodeURIComponent(f.artifact_id)}`}
                            data-testid={`biz-download-${e.entity_id}-${f.form_id}`}
                          >
                            Download
                          </a>
                        </div>
                        <table className="mt-1 w-full text-xs">
                          <tbody>
                            {f.lines.map((l) => (
                              <tr key={l.line_id} className="border-t border-slate-50">
                                <td className="py-0.5 font-mono">{l.line_id}</td>
                                <td>{l.label}</td>
                                <td className="text-right font-mono">{l.value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs" data-testid={`biz-handoff-${e.entity_id}`}>
                    <span className="font-semibold">K-1 handoff:</span> give each owner their K-1 (and IL Schedule
                    K-1-P) copy above. Enter YOUR OWN K-1 into the personal return on{' '}
                    <Link className="underline" href="/data">Add Data</Link> — the personal side treats it exactly
                    like any K-1 you receive.
                  </p>
                </>
              )}
            </section>
          ))}
        </>
      )}
    </main>
  );
}
