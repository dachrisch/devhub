import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/store';
import { suggestFeatureForProject } from '@/lib/suggest';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Topic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// "Suggest next" button (devhub#167 Phase 5): proposes the next feature for
// the project and saves it as a suggested topic (one click, no router needed).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const topic = await suggestFeatureForProject(projectId);
    return NextResponse.json({ topic });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
