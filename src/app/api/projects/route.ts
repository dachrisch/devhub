import { NextRequest, NextResponse } from 'next/server';
import { createProject, getProjectByName, updateProject, type Project } from '@/lib/store';
import { summarizeProject, type ProjectSummary } from '@/lib/project-status';
import { getProjects } from '@/lib/store';
import { publishProject } from '@/lib/sse';
import { getSession, requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import { PROJECT_STATUSES } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse<{ projects: ProjectSummary[] } | { error: string }>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const summaries = getProjects().map(summarizeProject);
  return NextResponse.json({ projects: summaries });
}

interface ProjectInput {
  name?: unknown;
  serviceRepoOwner?: unknown;
  serviceRepoName?: unknown;
  domain?: unknown;
  deployHost?: unknown;
  deployDir?: unknown;
  infraDir?: unknown;
  statusOverride?: unknown;
  releaseMode?: unknown;
  autoMerge?: unknown;
  config?: unknown;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function POST(req: NextRequest): Promise<NextResponse<{ project: Project } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as ProjectInput;
  const name = optionalString(body.name);
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (body.releaseMode !== undefined && body.releaseMode !== 'tag' && body.releaseMode !== 'manual') {
    return NextResponse.json({ error: 'releaseMode must be tag or manual' }, { status: 400 });
  }
  if (
    body.statusOverride !== undefined &&
    body.statusOverride !== null &&
    !(PROJECT_STATUSES as readonly string[]).includes(String(body.statusOverride))
  ) {
    return NextResponse.json({ error: 'invalid statusOverride' }, { status: 400 });
  }
  if (body.config !== undefined && (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config))) {
    return NextResponse.json({ error: 'config must be an object' }, { status: 400 });
  }

  const patch = {
    serviceRepoOwner: optionalString(body.serviceRepoOwner),
    serviceRepoName: optionalString(body.serviceRepoName),
    domain: optionalString(body.domain),
    deployHost: optionalString(body.deployHost),
    deployDir: optionalString(body.deployDir),
    infraDir: optionalString(body.infraDir),
    statusOverride: body.statusOverride === null ? null : (body.statusOverride as Project['statusOverride']),
    releaseMode: body.releaseMode as 'tag' | 'manual' | undefined,
    autoMerge: body.autoMerge === undefined ? undefined : body.autoMerge !== false,
    config: (body.config ?? undefined) as Record<string, unknown> | undefined,
  };

  const existing = getProjectByName(name);
  const project = (existing ? updateProject(existing.id, patch) : createProject({ name, ...patch }))!;
  publishProject(project.id);
  return NextResponse.json({ project });
}
