import { NextResponse } from 'next/server';
import { getIssues, type Issue } from '@/lib/store';
import { refreshIssues } from '@/lib/github';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse<{ issues: Issue[] }>> {
  return NextResponse.json({ issues: getIssues() });
}

export async function POST(): Promise<NextResponse> {
  try {
    const result = await refreshIssues();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
