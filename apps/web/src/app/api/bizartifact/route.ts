/** Stream one business-package artifact, rebuilt deterministically (P13). */
import { NextResponse, type NextRequest } from 'next/server';
import { appConfigured, requireContext } from '@/server/context';
import { rebuildEntityPackages } from '@/server/business';
import { withUserClient } from '@/server/db';
import { RateLimitError, takeBudget } from '@/server/limits';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!appConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 404 });
  const { userId, ws } = await requireContext();
  const entity = request.nextUrl.searchParams.get('entity');
  const artifactId = request.nextUrl.searchParams.get('artifact_id');
  if (!entity || !artifactId) return new NextResponse('entity and artifact_id are required', { status: 400 });
  try {
    await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'artifact'));
  } catch (e) {
    if (e instanceof RateLimitError) return NextResponse.json({ error: e.message }, { status: 429 });
    throw e;
  }
  const packages = await rebuildEntityPackages(userId, ws.workspace_id);
  const pkg = packages.find((p) => p.entity_id === entity);
  const artifact = pkg?.artifacts.find((a) => a.artifact_id === artifactId);
  if (!artifact) return new NextResponse('artifact not found in the rebuilt package', { status: 404 });
  const body: BodyInit = artifact.content_type === 'application/pdf' ? Buffer.from(artifact.content, 'base64') : artifact.content;
  return new NextResponse(body, {
    headers: {
      'content-type': artifact.content_type,
      'content-disposition': `attachment; filename="${artifactId.replaceAll(':', '-')}.${artifact.content_type === 'application/pdf' ? 'pdf' : 'txt'}"`,
    },
  });
}
