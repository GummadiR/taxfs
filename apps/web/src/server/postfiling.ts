/**
 * Post-filing state (TaxOS I.1/I.2, ported and made durable): Mark Filed
 * freezes the filed record with its column-A baseline; notices and
 * amendments are cases against it. Persisted as a settings row per
 * workspace-year — the filed baseline must outlive every restart.
 */
import { PostFilingStore, type PostFilingSnapshot } from '@taxfs/postfiling';
import type { Clock } from '@taxfs/shared';
import { withUserClient } from './db';
import { readSetting, writeSetting } from './filing';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

const KEY = 'postfiling.state';

export async function withPostFiling<T>(
  userId: string,
  ws: string,
  fn: (store: PostFilingStore) => T | Promise<T>,
): Promise<T> {
  return withUserClient(userId, async (client) => {
    const snap = ((await readSetting(client, ws, KEY)) as PostFilingSnapshot | undefined) ?? null;
    const store = PostFilingStore.fromSnapshot(new RealClock(), snap);
    const result = await fn(store);
    await writeSetting(client, ws, KEY, store.toSnapshot());
    return result;
  });
}
