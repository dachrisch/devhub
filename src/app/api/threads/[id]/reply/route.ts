import { NextRequest, NextResponse } from 'next/server';
import { getThread } from '@/lib/store';
import { replyToThread } from '@/lib/threads-run';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';
import type { OpencodeModel } from '@/lib/opencode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reply-from-detail resumes the run (same pattern as Work resume).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError)
      return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const { id } = await params;
  const threadId = Number(id);
  if (!Number.isInteger(threadId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const thread = getThread(threadId);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { text?: unknown; modelId?: unknown; providerID?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
  const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
  const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;

  void replyToThread(thread, text, { text, token: session.token, model: selectedModel }).catch((err) => {
    console.error(`[threads] reply #${threadId} threw:`, err instanceof Error ? err.message : err);
  });
  return NextResponse.json({ ok: true, threadId }, { status: 202 });
}
