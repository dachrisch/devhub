import { getActivityFleet } from './store';
import { getOpencodeFleetCached } from './sources/opencode-api';
import type { ActivitySession } from './types';

export interface ActivitySnapshot {
  fleet: ActivitySession[];
  generatedAt: string;
}

// Live fleet = opencode server snapshot (devhub#272) + ingested relay sessions
// (devhub#271). The server snapshot is best-effort: if opencode is unreachable
// the ingested fleet still renders. Attribution/client is layered on in #273.
export async function getActivitySnapshot(opts: { opencode?: boolean } = {}): Promise<ActivitySnapshot> {
  const ingested = getActivityFleet();
  let live: ActivitySession[] = [];
  if (opts.opencode !== false) {
    try {
      live = await getOpencodeFleetCached();
    } catch {
      live = [];
    }
  }
  return { fleet: [...live, ...ingested], generatedAt: new Date().toISOString() };
}
