import { NextRequest, NextResponse } from 'next/server';
import { appendAction, setActionStatus, getAction, getActions, appendSessionId, setActionTranscript, setDefaultModel } from '@/lib/store';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';
import { classifyInput } from '@/lib/router';
import { getByAction } from '@/lib/skills';
import { getAvailableModels, resolveModels, sanitizeModels, type OpencodeEvent, type OpencodeModel } from '@/lib/opencode';
import { createTranscriptRecorder } from '@/lib/action-transcript';
import { publishAction } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    input?: unknown;
    params?: unknown;
    modelId?: unknown;
    providerID?: unknown;
  };
  const input = typeof body.input === 'string' ? body.input.trim() : '';
  if (!input) {
    return NextResponse.json({ error: 'input is required' }, { status: 400 });
  }

  const params = typeof body.params === 'object' && body.params !== null
    ? body.params as Record<string, unknown>
    : {};

  // Optional model override (same body shape as the develop start route).
  // The chosen model is recorded on the row (so the detail view can audit it)
  // and persisted as the operator's last-used default once the run starts.
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const providerID = typeof body.providerID === 'string' ? body.providerID.trim() : '';
  const selectedModel: OpencodeModel | null = modelId && providerID ? { id: modelId, providerID } : null;
  const storedParams = selectedModel
    ? { ...params, modelId: selectedModel.id, providerID: selectedModel.providerID }
    : params;

  const action = appendAction(input, 'pending', storedParams);
  publishAction(action.id, 'pending', 'Understanding what you want...');

  // Fire-and-forget
  void executeAction(action.id, input, params, session.token, selectedModel);

  return NextResponse.json({ ok: true, actionId: action.id, status: 'pending' }, { status: 202 });
}

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

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit')) || 20;
  const actions = getActions(limit);
  return NextResponse.json({ actions });
}

async function executeAction(
  actionId: number,
  input: string,
  params: Record<string, unknown>,
  token: string,
  selectedModel: OpencodeModel | null
): Promise<void> {
  const startTime = Date.now();
  // The transcript recorder turns the opencode event stream into a bounded
  // rolling log: throttled SSE tail (~1/s) + flushed to the row (~1/s) so a
  // client opening the detail mid-run sees the transcript so far.
  const recorder = createTranscriptRecorder({
    onFlush: (text) => { setActionTranscript(actionId, text); },
    onTick: (line) => { publishAction(actionId, 'running', line); },
  });
  const onEvent = (event: OpencodeEvent) => { recorder.add(event); };

  try {
    setActionStatus(actionId, 'running');
    publishAction(actionId, 'running', 'Understanding what you want...');

    const models = sanitizeModels(resolveModels(selectedModel), await getAvailableModels());
    if (selectedModel?.id) {
      setDefaultModel({ id: selectedModel.id, providerID: selectedModel.providerID });
    }
    const sessionIds: string[] = [];

    // Classify what the user wants (its opencode events feed the transcript)
    const intent = await classifyInput(input, models, onEvent);

    if (intent.confidence < 0.5) {
      recorder.final();
      setActionStatus(actionId, 'failed', `Not sure what you mean. Could you rephrase?`);
      publishAction(actionId, 'failed', 'Could not understand');
      return;
    }

    // Find the skill that handles this action
    const skill = intent.action !== 'unknown' ? getByAction(intent.action) : null;
    if (!skill) {
      recorder.final();
      setActionStatus(actionId, 'failed', `I can "${intent.action}" yet — that skill isn't built yet.`);
      publishAction(actionId, 'failed', `Not ready yet: ${intent.action}`);
      return;
    }

    publishAction(actionId, 'running', `Working on: ${skill.manifest.name}`);

    // Execute the skill
    const result = await skill.execute({
      actionId,
      input,
      params: intent.params,
      token,
      models,
      onEvent,
      onStatus: (detail) => { publishAction(actionId, 'running', detail); },
      onStartSession: (sid) => {
        sessionIds.push(sid);
        appendSessionId(actionId, sid);
      },
    });

    recorder.final();
    const duration = Date.now() - startTime;
    setActionStatus(actionId, result.success ? 'success' : 'failed', result.summary, duration);
    publishAction(actionId, result.success ? 'success' : 'failed', result.summary);

  } catch (err) {
    recorder.final();
    const reason = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;
    setActionStatus(actionId, 'failed', reason, duration);
    publishAction(actionId, 'failed', reason);
  }
}
