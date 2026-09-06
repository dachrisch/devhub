import { NextRequest, NextResponse } from 'next/server';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';
import { clusterUnknowns } from '@/lib/learning';
import { listKnowledge } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Self-learning insights: repeated unknown requests clustered into skill
// proposals, plus recent teach-by-rerun corrections. No new storage — reads
// the live `actions` table and `knowledge_fts`.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit')) || 100;
  const clusters = clusterUnknowns(limit);
  const corrections = listKnowledge('router-correction', 20);
  const unknowns = listKnowledge('router-unknown', 20);
  return NextResponse.json({
    clusters: clusters.filter((c) => c.count > 1),
    corrections: corrections.map((c) => ({ id: c.id, memory: c.memory, createdAt: c.createdAt })),
    unknownCount: unknowns.length,
  });
}
