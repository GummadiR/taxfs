/**
 * P6.4 — Owned-entity returns (1120-S / 1065): enter the entity's books and
 * members, see the computed entity lines and the DERIVED outbound K-1s.
 * The entity→personal orchestrator handoff is a recorded gap: enter your
 * own K-1 from the generated numbers on Add Data for now.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ENTITY_DEDUCTION_CATEGORIES, ENTITY_K_LINES, SCHC_EXPENSE_CATEGORIES } from '@taxfs/shared';
import { appConfigured, requireContext } from '@/server/context';
import { structuredEntry as saveStructured } from '@/server/structured';
import { getEntityReturns } from '@/server/business';
import { PageHelp } from '@/components/pagehelp';
import { SubmitButton } from '@/components/submit-button';

async function structuredEntry(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const msg = await saveStructured(userId, ws.workspace_id, formData);
  redirect(`/entities?msg=${encodeURIComponent(msg)}`);
}


/** Hover the label (or the ⓘ) to see where the number comes from. */
function Hint({ hint }: { hint?: string }) {
  if (!hint) return null;
  return (
    <span className="ml-0.5 cursor-help text-slate-400" title={hint} aria-label={hint}>
      ⓘ
    </span>
  );
}

function SpAmount({ name, label, required = false, hint }: { name: string; label: string; required?: boolean; hint?: string }) {
  return (
    <label className="block text-xs" title={hint}>
      {label}
      {required ? ' *' : ''}
      <Hint hint={hint} />
      <input name={name} inputMode="decimal" className="mt-1 block w-36 rounded border p-1" data-testid={`field-${name}`} />
    </label>
  );
}

function Amount({ name, label, required = false }: { name: string; label: string; required?: boolean }) {
  return (
    <label className="block text-xs">
      {label}
      {required ? ' *' : ''}
      <input name={name} inputMode="decimal" className="mt-1 block w-36 rounded border p-1" data-testid={`ent-${name}`} />
    </label>
  );
}

export default async function Entities({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const dto = await getEntityReturns(userId, ws.workspace_id);
  return (
    <main className="space-y-6">
      <h1 className="text-xl font-black">Owned entities</h1>
      {msg ? <p className="rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="entities-msg">{msg}</p> : null}
      <PageHelp
        what={'Your businesses that file their OWN returns (S-corps → 1120-S, partnerships/multi-member LLCs → 1065, plus Illinois replacement tax). Enter each entity\'s books and owner shares; TaxFS computes the entity return and derives every owner\'s K-1 exactly.'}
        doThis={[
          'Save each entity (type, receipts, deductions) and its members with ownership shares.',
          'Check the computed entity lines and the derived K-1 boxes against your records.',
          'Build each entity\'s filing package (return + every owner\'s K-1) on Business Filing, and enter YOUR K-1 on Add Data for the personal return.',
        ]}
      />
      <p className="text-sm text-slate-600">
        1120-S / 1065 books. Every Schedule K line allocates to members with cumulative rounding — the
        K-1 boxes always sum exactly to the entity line (pinned by the 2022 back-test oracle). When the books
        are entered, build the per-entity filing packages on{' '}
        <Link className="underline" href="/business">Business Filing</Link>.
      </p>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-entity">
        <h2 className="font-bold">Entity core</h2>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="entity" />
          <label className="block text-xs">
            Entity id *
            <input name="entity_id" placeholder="aantic-llc" className="mt-1 block w-32 rounded border p-1" data-testid="ent-entity_id" />
          </label>
          <label className="block text-xs">
            Type *
            <select name="is_scorp" defaultValue="1" className="mt-1 block rounded border p-1" data-testid="ent-is_scorp">
              <option value="1">S-corp (1120-S)</option>
              <option value="0">partnership (1065)</option>
            </select>
          </label>
          <Amount name="gross_receipts" label="Gross receipts" />
          <Amount name="returns_allowances" label="Returns/allowances" />
          <Amount name="cogs" label="COGS" />
          <Amount name="liabilities_beginning" label="Liabilities begin (1065)" />
          <Amount name="liabilities_ending" label="Liabilities end (1065)" />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-entity">
            Save entity
          </SubmitButton>
        </form>
        <form action={structuredEntry} className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="family" value="entity_deduction" />
          <label className="block text-xs">
            Entity id *
            <input name="entity_id" className="mt-1 block w-32 rounded border p-1" data-testid="ent-ded-entity" />
          </label>
          <label className="block text-xs">
            Deduction *
            <select name="category" className="mt-1 block rounded border p-1" data-testid="ent-ded-category">
              {ENTITY_DEDUCTION_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.replaceAll('_', ' ')}</option>
              ))}
            </select>
          </label>
          <Amount name="amount" label="Amount" required />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-ent-ded">
            Save deduction
          </SubmitButton>
        </form>
        <form action={structuredEntry} className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="family" value="entity_k" />
          <label className="block text-xs">
            Entity id *
            <input name="entity_id" className="mt-1 block w-32 rounded border p-1" data-testid="ent-k-entity" />
          </label>
          <label className="block text-xs">
            Schedule K line *
            <select name="k_line" className="mt-1 block rounded border p-1" data-testid="ent-k-line">
              {ENTITY_K_LINES.map((c) => (
                <option key={c} value={c}>{c.replaceAll('_', ' ')}</option>
              ))}
            </select>
          </label>
          <Amount name="amount" label="Amount" required />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-ent-k">
            Save K line
          </SubmitButton>
        </form>
        <form action={structuredEntry} className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="family" value="entity_member" />
          <label className="block text-xs">
            Entity id *
            <input name="entity_id" className="mt-1 block w-32 rounded border p-1" data-testid="ent-m-entity" />
          </label>
          <label className="block text-xs">
            Member id *
            <input name="member_id" placeholder="me" className="mt-1 block w-28 rounded border p-1" data-testid="ent-m-member" />
          </label>
          <Amount name="share" label="Ownership share (0-1)" required />
          <Amount name="guaranteed_payment" label="Partner payment for services (1065 box 4)" />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-ent-member">
            Save member
          </SubmitButton>
        </form>
        <p className="mt-2 text-xs text-slate-500">Member shares must sum to exactly 1 — the entity run refuses otherwise.</p>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="entity-results">
        <h2 className="font-bold">Computed entity return + outbound K-1s</h2>
        {dto.error ? (
          <p className="mt-2 rounded bg-red-50 p-2 font-mono text-xs text-red-700" data-testid="entity-error">{dto.error}</p>
        ) : dto.lines.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No entity data yet — save an entity above.</p>
        ) : (
          <ul className="mt-2 space-y-0.5 font-mono text-xs" data-testid="entity-lines">
            {dto.lines.map((l) => (
              <li key={l.concept}>
                {l.concept} = {l.value}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-500">
          The k1.* lines are the members&apos; Schedule K-1s. Until the entity→personal handoff is wired
          (recorded gap), enter YOUR K-1 on Add Data using these numbers.
        </p>
      </section>

      <section className="rounded border border-amber-200 bg-amber-50 p-4 text-sm" data-testid="soleprop-note">
        <h2 className="font-bold">Sole proprietorship (Schedule C) — only if a business has NO S-corp/partnership election</h2>
        <p className="mt-1 text-xs text-slate-600">
          A single-member LLC with no election is, by IRS rule, reported on Schedule C INSIDE the owner&apos;s
          personal 1040 — it cannot file separately. If all your businesses are S-corps or partnerships
          (multi-member LLCs), leave this section empty: their books belong on the entity returns above, their
          equipment depreciates there too, and your personal return only receives their K-1s.
        </p>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-business">
        <h2 className="font-bold">Business (Schedule C)</h2>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="business" />
          <label className="block text-xs">
            Business id *
            <input name="entity_id" placeholder="aantic" className="mt-1 block w-32 rounded border p-1" data-testid="field-entity_id" />
          </label>
          <SpAmount name="gross_receipts" label="Gross receipts" required hint="Total business income received this year (your invoices/1099-NEC/1099-K totals), before any expenses." />
          <SpAmount name="returns_allowances" label="Returns/allowances" hint="Refunds you issued to customers. Blank if none." />
          <SpAmount name="cogs" label="Cost of goods sold" hint="Direct cost of products sold (inventory-based businesses). Blank for pure service businesses." />
          <SpAmount name="startup_costs_total" label="Startup costs (§195)" hint="Costs paid BEFORE the business opened (formation, research, pre-launch marketing). First $5,000 deducts now, the rest amortizes over 180 months." />
          <SpAmount name="startup_amort_months" label="Startup months this yr" hint="Months the business operated this year, counting the month it opened (opened in July = 6)." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-business">
            Save business
          </SubmitButton>
        </form>
        <form action={structuredEntry} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="family" value="business_expense" />
          <label className="block text-xs">
            Business id *
            <input name="entity_id" placeholder="aantic" className="mt-1 block w-32 rounded border p-1" data-testid="field-exp-entity" />
          </label>
          <label className="block text-xs">
            Category *
            <select name="category" className="mt-1 block rounded border p-1" data-testid="field-category">
              {SCHC_EXPENSE_CATEGORIES.filter((c) => c !== 'home_office').map((c) => (
                <option key={c} value={c}>
                  {c.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <SpAmount name="amount" label="Amount" required hint="Total spent in this category this year. Meals: enter the FULL amount — the engine applies the 50% limit." />
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-expense">
            Save expense
          </SubmitButton>
          <p className="w-full text-xs text-slate-500">
            Meals: enter the FULL amount — the 50% limit is applied by the calculation engine, never by you.
          </p>
        </form>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid="form-dep">
        <h2 className="font-bold">Depreciable asset (Form 4562)</h2>
        <form action={structuredEntry} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="family" value="dep_asset" />
          <label className="block text-xs">
            Business id *
            <input name="entity_id" placeholder="aantic" className="mt-1 block w-32 rounded border p-1" data-testid="field-dep-entity" />
          </label>
          <label className="block text-xs">
            Asset id *
            <input name="asset_id" placeholder="laptop1" className="mt-1 block w-32 rounded border p-1" data-testid="field-asset_id" />
          </label>
          <SpAmount name="basis" label="Cost basis" required />
          <SpAmount name="sec179" label="§179 elected" hint="How much of the cost you elect to deduct fully THIS year (up to the cost). Blank = regular depreciation." />
          <label className="block text-xs">
            Recovery life *
            <select name="life_years" defaultValue="5" className="mt-1 block rounded border p-1" data-testid="field-life_years">
              <option value="5">5-year</option>
              <option value="7">7-year</option>
            </select>
          </label>
          <SubmitButton className="rounded bg-slate-900 px-3 py-1.5 text-white" data-testid="save-dep">
            Save asset
          </SubmitButton>
        </form>
      </section>

    </main>
  );
}
