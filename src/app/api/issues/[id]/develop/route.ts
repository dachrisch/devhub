import { NextRequest, NextResponse } from 'next/server';
import { getIssue } from '@/lib/store';
import { canDevelop, startDevelop } from '@/lib/develop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
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

  const body = (await req.json().catch(() => ({}))) as { command?: unknown };
  const command = typeof body.command === 'string' ? body.command : '';

  // Fire-and-forget: the route returns immediately; progress streams via SSE.
  void startDevelop(issue, command);

  return NextResponse.json({ ok: true, state: 'developing' }, { status: 202 });
}
