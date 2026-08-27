/**
 * Serve one locked artifact's bytes — identity-free by construction (the
 * server never receives identity; the BROWSER fills Step-1 fields at
 * download, §5). Regenerated deterministically and verified against the
 * SHA-256 frozen at lock; membership + RLS scope everything.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireContext, appConfigured } from '@/server/context';
import { regenerateArtifact } from '@/server/packages';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!appConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 404 });
  const { userId, ws } = await requireContext();
  const packageId = request.nextUrl.searchParams.get('package_id');
  const artifactId = request.nextUrl.searchParams.get('artifact_id');
  if (!packageId || !artifactId) {
    return NextResponse.json({ error: 'package_id and artifact_id are required' }, { status: 400 });
  }
  const { content, content_type } = await regenerateArtifact(userId, ws.workspace_id, packageId, artifactId);
  const body: BodyInit = content_type === 'application/pdf' ? Buffer.from(content, 'base64') : content;
  return new NextResponse(body, {
    headers: {
      'content-type': content_type,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${artifactId.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}"`,
    },
  });
}
