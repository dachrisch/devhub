import { NextRequest, NextResponse } from 'next/server';
import { ENV } from '@/lib/env';
import { parseBatch, safeEqual } from '@/lib/activity/ingest';
import {
  appendActivityEvents,
  recordActivityHeartbeat,
  upsertActivitySessions,
} from '@/lib/activity/store';
import { publishActivity } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Receiving side of the Agent Activity contract (devhub#271). Authed by the
// shared X-Activity-Token secret; the setup-home agent-relay is the producer.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = ENV.activityIngestToken;
  if (!expected) return NextResponse.json({ error: 'ingest not configured' }, { status: 503 });
  const provided = req.headers.get('x-activity-token') ?? '';
  if (!safeEqual(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const batch = parseBatch(body);
  if (!batch) return NextResponse.json({ error: 'invalid batch' }, { status: 400 });

  const sessions = upsertActivitySessions(batch.source, batch.sessions ?? []);
  const events = appendActivityEvents(batch.source, batch.events ?? []);
  recordActivityHeartbeat(batch.source, batch.sentAt ?? null, null, batch.history);
  publishActivity(batch.source);

  return NextResponse.json({ ok: true, sessions, events }, { status: 202 });
}
