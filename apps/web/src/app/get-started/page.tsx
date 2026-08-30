import { SubmitButton } from '@/components/submit-button';
import { redirect } from 'next/navigation';
import { PageHelp } from '@/components/pagehelp';
import { appConfigured, requireContext } from '@/server/context';
import { withUserClient } from '@/server/db';
import { filingContext, parseFilingStatus, saveFilingChoices } from '@/server/filing';
import { TAX_YEAR } from '@/server/env';

async function save(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const filing_status = parseFilingStatus(String(formData.get('filing_status')));
  const il_exemption_count = Number(formData.get('il_exemption_count') ?? 1);
  const addl_std_boxes = Number(formData.get('addl_std_boxes') ?? 0);
  if (!Number.isInteger(il_exemption_count) || il_exemption_count < 0 || il_exemption_count > 4) throw new Error('IL exemptions must be 0–4');
  if (!Number.isInteger(addl_std_boxes) || addl_std_boxes < 0 || addl_std_boxes > 4) throw new Error('age/blind boxes must be 0–4');
  await withUserClient(userId, (client) =>
    saveFilingChoices(client, ws.workspace_id, { filing_status, il_exemption_count, addl_std_boxes }));
  redirect('/documents');
}

const STATUS_LABELS: [string, string][] = [
  ['single', 'Single'], ['mfj', 'Married filing jointly'], ['mfs', 'Married filing separately'],
  ['hoh', 'Head of household'], ['qss', 'Qualifying surviving spouse'],
];

export default async function GetStarted() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const current = await withUserClient(userId, (client) => filingContext(client, ws.workspace_id));
  return (
    <main className="max-w-lg">
      <h1 className="text-xl font-black">Get Started — tax year {TAX_YEAR}</h1>
      <p className="mt-1 text-sm text-slate-600">
        Filing choices for <span className="font-semibold">{ws.display_name}</span>. No names, SSNs or birth dates
        are asked here — identity never reaches the server.
      </p>
      <div className="mt-3">
        <PageHelp
          what={'Sets up your return: the tax year and your filing status. TaxFS supports full-year Illinois residents; anything outside scope stops here on purpose rather than producing a wrong return.'}
          doThis={[
            `Pick tax year ${TAX_YEAR} and your filing status (e.g. Married filing jointly).`,
            'Set the Illinois exemption count and any §63(f) boxes that apply.',
            'Save — then go to Documents.',
          ]}
        />
      </div>
      <form action={save} className="mt-4 space-y-4">
        <label className="block text-sm">
          Filing status
          <select name="filing_status" defaultValue={current?.filing_status ?? 'single'}
            className="mt-1 w-full rounded border border-slate-300 p-2" data-testid="filing-status">
            {STATUS_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          Illinois exemptions (you + spouse)
          <span className="mt-0.5 block text-xs font-normal text-slate-500">
            One per person on the return — yourself, plus your spouse on a joint return. Each exemption
            subtracts a per-person amount (from the loaded rule-data) from Illinois income.
          </span>
          <input name="il_exemption_count" type="number" min={0} max={4}
            defaultValue={current?.il_exemption_count ?? 1}
            className="mt-1 w-24 rounded border border-slate-300 p-2" />
        </label>
        <label className="block text-sm">
          Age 65+ / blind boxes (extra standard deduction)
          <span className="mt-0.5 block text-xs font-normal text-slate-500">
            Count every box that applies across the federal checklist: you 65 or older, you blind, spouse 65
            or older, spouse blind (0–4). Each one raises your standard deduction under IRC §63(f), with the
            per-box amount coming from the loaded rule-data. Only the COUNT is stored — never who is older or
            blind; identity stays out of the database.
          </span>
          <input name="addl_std_boxes" type="number" min={0} max={4}
            defaultValue={current?.addl_std_boxes ?? 0}
            className="mt-1 w-24 rounded border border-slate-300 p-2" />
        </label>
        <SubmitButton className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white" pendingText="Saving…">
          Save and continue
        </SubmitButton>
      </form>
    </main>
  );
}
