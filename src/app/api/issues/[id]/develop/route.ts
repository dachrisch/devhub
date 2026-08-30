import { NextRequest, NextResponse } from 'next/server';
import { getIssue } from '@/lib/store';
import { canDevelop, startDevelop } from '@/lib/develop';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';
import type { OpencodeModel } from '@/lib/opencode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!canDevelop(issue)) {
    return NextResponse.json(
      { error: `issue is '${issue.state}'; only backlog/blocked issues can be developed` },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    command?: unknown;
    modelId?: unknown;
    providerID?: unknown;
  };
  const command = typeof body.command === 'string' ? body.command : '';
  const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
  const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
  const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;

  // Fire-and-forget: the route returns immediately; progress streams via SSE.
  void startDevelop(issue, command, session.token, selectedModel);

  return NextResponse.json({ ok: true, state: 'developing' }, { status: 202 });
}
