import { NextRequest, NextResponse } from 'next/server';
import { getEvents, getIssue, type Issue, type IssueEvent } from '@/lib/store';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DetailResponse {
  issue: Issue;
  events: IssueEvent[];
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse<DetailResponse>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' } as unknown as DetailResponse, { status: 401 });
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' } as unknown as DetailResponse, { status: 400 });
  }
  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' } as unknown as DetailResponse, { status: 404 });
  }
  return NextResponse.json({ issue, events: getEvents(issueId) });
}
