import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-base-gate-test-${process.pid}.db`);

afterAll(() => {
  for (const f of [process.env.DEVHUB_DB!, `${process.env.DEVHUB_DB}-wal`, `${process.env.DEVHUB_DB}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

const checkCalls: unknown[][] = [];
const checkMode: { mode: 'ok' | 'fail' | 'throw' } = { mode: 'ok' };
// Queued opencode replies, one per runDevelop call (develop session first,
// verifier session second).
const runTexts: string[] = [];
const runPrompts: string[] = [];
const developPrompts: string[] = [];

vi.mock('./opencode.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./opencode.js')>();
  return {
    ...orig,
    ensureWorktree: async () => ({ directory: '/tmp/wt', branch: 'opencode/9-service' }),
    runDevelop: async (prompt: string) => {
      runPrompts.push(prompt);
      const next = runTexts.shift();
      if (next === undefined) throw new Error('runDevelop called with no queued response');
      return next;
    },
    buildDevelopPrompt: (...args: Parameters<typeof orig.buildDevelopPrompt>) => {
      const prompt = orig.buildDevelopPrompt(...args);
      developPrompts.push(prompt);
      return prompt;
    },
    getAvailableModels: async () => [],
  };
});

vi.mock('./github.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./github.js')>();
  return {
    ...orig,
    checkPrBase: async (...args: unknown[]) => {
      checkCalls.push(args);
      if (checkMode.mode === 'throw') throw new Error('github down');
      return checkMode.mode === 'ok'
        ? { ok: true, reason: null }
        : {
            ok: false,
            reason:
              'PR contains commits from 2 distinct authors (human@elsewhere, opencode@x) — the branch was cut from the wrong base, not latest master',
          };
    },
    setIssueStateLabels: async () => {},
    updateIssueBody: async () => {},
    isIssueClosedOnGitHub: async () => false,
    commentOnIssue: async () => {},
  };
});

const { startDevelop } = await import('./develop.js');
const store = await import('./store.js');

const SHA = 'a'.repeat(40);
const PR_URL = 'https://github.com/dachrisch/widget/pull/99';

async function developingIssue(n: number) {
  store.upsertIssue({
    githubIssueId: 9000 + n,
    owner: 'dachrisch',
    repo: 'widget',
    number: 90 + n,
    title: `base gate ${n}`,
    body: null,
    htmlUrl: `https://github.com/dachrisch/widget/issues/${90 + n}`,
  });
  const id = store.getIssueByGithub('dachrisch', 'widget', 90 + n)!.id;
  store.setIssueState(id, 'developing');
  return store.getIssue(id)!;
}

function reset() {
  checkCalls.length = 0;
  runTexts.length = 0;
  runPrompts.length = 0;
  developPrompts.length = 0;
}

describe('base-branch gate in startDevelop', () => {
  it('records the BASE_SHA handshake and advances to pr when the base is clean', async () => {
    reset();
    checkMode.mode = 'ok';
    // No refinement event → no criteria → verification skips with a trace.
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`);
    const issue = await developingIssue(1);

    await startDevelop(issue, '', 'token-abc');

    expect(checkCalls[0].slice(0, 3)).toEqual(['dachrisch', 'widget', PR_URL]);
    const runs = store.getRunsForIssue(issue.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe('pr');
    expect(runs[0].prUrl).toBe(PR_URL);
    expect(runs[0].baseSha).toBe(SHA);
    expect(store.getIssue(issue.id)?.state).toBe('pr');
  });

  it('fails the run (keeping the PR url) when the base is polluted, so retry renormalizes', async () => {
    reset();
    checkMode.mode = 'fail';
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`);
    const issue = await developingIssue(2);

    await startDevelop(issue, '', 'token-abc');

    const runs = store.getRunsForIssue(issue.id);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].prUrl).toBe(PR_URL);
    const updated = store.getIssue(issue.id)!;
    expect(updated.state).toBe('developing');
    expect(updated.blockedReason).toContain('Wrong base branch');
  });

  it('fails open with a trace when the base check itself errors', async () => {
    reset();
    checkMode.mode = 'throw';
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`);
    const issue = await developingIssue(3);

    await startDevelop(issue, '', 'token-abc');

    const runs = store.getRunsForIssue(issue.id);
    expect(runs[0].state).toBe('pr');
    expect(store.getIssue(issue.id)?.state).toBe('pr');
  });
});

describe('acceptance-criteria verification gate', () => {
  const CRITERIA = ['pill renders on all pages', 'build stays green'];

  function seedCriteria(issueId: number) {
    store.appendEvent(issueId, 'refinement', {
      status: 'completed',
      ready: true,
      summary: 'ready',
      blockingQuestions: [],
      scope: 'service',
      infraFirst: false,
      acceptanceCriteria: CRITERIA,
    });
  }

  function verdicts(pass: boolean[]) {
    return JSON.stringify({
      verdicts: pass.map((p, i) => ({ ac: i + 1, pass: p, evidence: p ? `file${i}.ts:1` : 'not done' })),
    });
  }

  it('advances to pr only after the verifier passes every criterion', async () => {
    reset();
    checkMode.mode = 'ok';
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`, verdicts([true, true]));
    const issue = await developingIssue(4);
    seedCriteria(issue.id);

    await startDevelop(issue, '', 'token-abc');

    // Two sessions ran: develop, then the read-only verifier.
    expect(runPrompts).toHaveLength(2);
    expect(store.getRunsForIssue(issue.id)[0].state).toBe('pr');
    expect(store.getIssue(issue.id)?.state).toBe('pr');
    const verification = store.getEvents(issue.id).filter((e) => e.kind === 'verification');
    expect(verification.at(-1)?.payload).toMatchObject({ status: 'completed', allPass: true });
  });

  it('fails PR runs on unmet criteria and feeds the verdicts to the retry', async () => {
    reset();
    checkMode.mode = 'ok';
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`, verdicts([false, true]));
    const issue = await developingIssue(5);
    seedCriteria(issue.id);

    await startDevelop(issue, '', 'token-abc');

    // Runs reset to failed with the PR kept; card waits with the findings.
    let runs = store.getRunsForIssue(issue.id);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].prUrl).toBe(PR_URL);
    const blocked = store.getIssue(issue.id)!;
    expect(blocked.state).toBe('developing');
    expect(blocked.blockedReason).toContain('AC verification failed');

    // Retry re-develops (not re-verifies the same diffs) with the verdicts.
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`, verdicts([true, true]));
    await startDevelop(store.getIssue(issue.id)!, '', 'token-abc');

    expect(developPrompts).toHaveLength(2);
    expect(developPrompts[1]).toContain('Previous verification failure');
    expect(developPrompts[1]).toContain('AC 1');
    runs = store.getRunsForIssue(issue.id);
    expect(runs[0].state).toBe('pr');
    expect(store.getIssue(issue.id)?.state).toBe('pr');
  });

  it('skips verification with a trace when no criteria were recorded', async () => {
    reset();
    checkMode.mode = 'ok';
    runTexts.push(`BASE_SHA: ${SHA}\ndone -> ${PR_URL}`);
    const issue = await developingIssue(6);
    // No refinement event: legacy issue, nothing to verify against.

    await startDevelop(issue, '', 'token-abc');

    expect(runPrompts).toHaveLength(1);
    expect(store.getIssue(issue.id)?.state).toBe('pr');
    const verification = store.getEvents(issue.id).filter((e) => e.kind === 'verification');
    expect(verification.at(-1)?.payload).toMatchObject({ status: 'skipped' });
  });
});
