import { NextRequest, NextResponse } from 'next/server';
import { getProjects } from '@/lib/store';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Legacy compat endpoint: sourced from the projects table (devhub#167). The
// `services` table stays in place, unused, until a later cleanup. New clients
// should use GET /api/projects.
export async function GET(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const services = getProjects().map((p) => ({
    id: p.id,
    name: p.name,
    repoOwner: p.serviceRepoOwner,
    repoName: p.serviceRepoName,
    deployHost: p.deployHost,
    deployDir: p.deployDir,
    domain: p.domain,
    status: p.statusOverride ?? p.status ?? 'active',
    lastDeployAt: p.lastShippedAt,
    config: typeof p.config === 'string' ? p.config : JSON.stringify(p.config ?? {}),
    createdAt: p.createdAt,
  }));
  return NextResponse.json({ services });
}
