'use server';

/** Server action behind the lineage drawer: fact id → the DTO the drawer draws. */
import { requireContext } from './context';
import { withSpine } from './db';
import { TAX_YEAR } from './env';
import { toLineageDto, type LineageDto } from './lineage';

export async function fetchLineage(factId: string): Promise<LineageDto | null> {
  const { userId, ws } = await requireContext();
  return withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
    const node = await spine.getLineage(factId).catch(() => null);
    if (!node) return null;
    const sources = await spine.getSources(ws.workspace_id, TAX_YEAR);
    return toLineageDto(node, sources);
  });
}
