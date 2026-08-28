/**
 * Upload Route Handler (TaxOS P15 shape): Server Actions cap request bodies
 * at 1 MB, so a real scan dies before our code runs. Routes have no cap.
 * One file per request (the dropzone sends sequentially). The upload
 * budget applies per request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { appConfigured, requireContext } from '@/server/context';
import { uploadDocuments } from '@/server/upload';
import { withUserClient } from '@/server/db';
import { RateLimitError, takeBudget } from '@/server/limits';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!appConfigured()) return NextResponse.json({ message: 'not configured' }, { status: 404 });
  const { userId, ws } = await requireContext();
  try {
    await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'upload'));
  } catch (e) {
    if (e instanceof RateLimitError) return NextResponse.json({ message: e.message }, { status: 429 });
    throw e;
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ message: 'no file in the request' }, { status: 400 });
  const report = await uploadDocuments(userId, ws.workspace_id, [file]);
  // Blocked (un-scrubbable) is a refusal with instructions — surface as an
  // error so the dropzone shows it prominently.
  if (report.blocked.length > 0) {
    const b = report.blocked[0]!;
    return NextResponse.json({ message: `${b.reason} ${b.instructions}` }, { status: 422 });
  }
  return NextResponse.json({ messages: report.messages });
}
