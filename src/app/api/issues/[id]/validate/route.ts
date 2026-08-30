import { NextRequest, NextResponse } from 'next/server';
import { getIssue, appendEvent } from '@/lib/store';
import { runDevelop, resolveModels, type OpencodeEvent } from '@/lib/opencode';
import { buildValidatePrompt, parseValidationResult } from '@/lib/validate';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Only validate issues in backlog or refinement state
  if (issue.state !== 'backlog' && issue.state !== 'refinement') {
    return NextResponse.json(
      { error: `issue is '${issue.state}'; only backlog/refinement issues can be validated` },
      { status: 409 }
    );
  }

  const models = resolveModels();
  const prompt = buildValidatePrompt(issue);
  
  try {
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const text = await runDevelop(prompt, onEvent, models);
    const result = parseValidationResult(text);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });
    
    return NextResponse.json({ 
      ok: true, 
      ready: result.ready, 
      summary: result.summary,
      text 
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation', { status: 'error', error: reason });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
