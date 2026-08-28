/** Stream the assembled Defense File as a JSON bundle (TaxOS E.6, ported). */
import { NextResponse } from 'next/server';
import { appConfigured, requireContext } from '@/server/context';
import { assembleDefenseFile } from '@/server/risk';
import { withUserClient } from '@/server/db';
import { RateLimitError, takeBudget } from '@/server/limits';

export async function GET(): Promise<NextResponse> {
  if (!appConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 404 });
  const { userId, ws } = await requireContext();
  try {
    await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'artifact'));
  } catch (e) {
    if (e instanceof RateLimitError) return NextResponse.json({ error: e.message }, { status: 429 });
    throw e;
  }
  try {
    const file = await assembleDefenseFile(userId, ws.workspace_id);
    return new NextResponse(JSON.stringify(file, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="defense-file-${file.package_version}.json"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
