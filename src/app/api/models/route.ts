import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { defaultModels, getAvailableModels, type OpencodeModel } from '@/lib/opencode';
import { getDefaultModel } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only model listing for the develop modal. Must never throw: on any
// failure it falls back to the pinned known-good tiers.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  let models: OpencodeModel[];
  try {
    models = await getAvailableModels();
  } catch {
    models = defaultModels();
  }
  return NextResponse.json({ models, default: getDefaultModel() });
}