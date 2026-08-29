/**
 * Draft preview on the REAL government form (TaxOS P14.8, ported): fills
 * the official IRS/IL PDF template with the CURRENT confirmed facts for one
 * form and streams it inline. Identity fields stay EMPTY — the server never
 * has them (G9); the locked package on File It remains the artifact of
 * record. Membership + RLS scope everything; the artifact budget applies.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { fillPdfForm, populateInstances, resolveFormSet } from '@taxfs/forms';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import { releases } from '@/server/rules';
import { TAX_YEAR } from '@/server/env';
import { RateLimitError, takeBudget } from '@/server/limits';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!appConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 404 });
  const { userId, ws } = await requireContext();
  const formId = request.nextUrl.searchParams.get('form_id');
  if (!formId) return new NextResponse('missing form_id', { status: 400 });
  try {
    await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'artifact'));
  } catch (e) {
    if (e instanceof RateLimitError) return NextResponse.json({ error: e.message }, { status: 429 });
    throw e;
  }
  const rel = releases();
  const map = rel.fieldMaps.forms[formId];
  const template = rel.pdfTemplates[formId];
  if (!map || !template) {
    return new NextResponse('no official PDF template/field map for this form yet', { status: 404 });
  }
  const filing = await withUserClient(userId, (client) => filingContext(client, ws.workspace_id));
  if (!filing) return new NextResponse('complete Get Started first', { status: 409 });
  const facts = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) =>
    (await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR })).filter((f) => f.status === 'confirmed'));
  for (const release of [rel.formsFed, rel.formsIl]) {
    const defs = resolveFormSet(release, facts);
    const def = defs.find((d) => d.form_id === formId);
    if (!def) continue;
    const { instances } = populateInstances([def], facts, ws.workspace_id, TAX_YEAR);
    const instance = instances[0];
    if (!instance || Object.keys(instance.values).length === 0) break;
    const result = await fillPdfForm(template, def, instance, map, filing.filing_status);
    return new NextResponse(Buffer.from(result.bytes), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="draft-${formId}.pdf"`,
      },
    });
  }
  return new NextResponse('form not in the current draft return', { status: 404 });
}
