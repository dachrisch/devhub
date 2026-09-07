import { NextRequest, NextResponse } from 'next/server';
import { deleteProject, getProject, updateProject, type Project } from '@/lib/store';
import { publishProject } from '@/lib/sse';
import { getSession, requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import { PROJECT_STATUSES } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ project: Project } | { error: string }>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const projectId = parseId(id);
  if (!projectId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ project });
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ project: Project } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const projectId = parseId(id);
  if (!projectId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const existing = getProject(projectId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
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

  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'serviceRepoOwner', 'serviceRepoName', 'domain', 'deployHost', 'deployDir', 'infraDir'] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      patch[key] = v === null ? null : typeof v === 'string' && v.trim() ? v.trim() : null;
    }
  }
  if (body.statusOverride !== undefined) {
    patch.statusOverride = body.statusOverride === null ? null : String(body.statusOverride);
  }
  if (body.releaseMode !== undefined) patch.releaseMode = body.releaseMode;
  if (body.config !== undefined) patch.config = body.config;

  const project = updateProject(projectId, patch);
  publishProject(projectId);
  return NextResponse.json({ project: project! });
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ ok: boolean } | { error: string }> | NextResponse> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const projectId = parseId(id);
  if (!projectId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const result = deleteProject(projectId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  publishProject(projectId);
  return NextResponse.json({ ok: true });
}
