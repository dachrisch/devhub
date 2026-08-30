import { describe, expect, it } from 'vitest';
import { broadcaster, publishIssue, publishOpencodeEvent } from './sse.js';
import type { Issue } from './types.js';

const sampleIssue: Issue = {
  id: 1,
  githubIssueId: 1,
  owner: 'dachrisch',
  repo: 'r',
  number: 1,
  title: 't',
  body: null,
  htmlUrl: 'u',
  state: 'backlog',
  sessionId: null,
  resultPrUrl: null,
  resultText: null,
  linkedPrUrl: null,
  createdAt: '',
  updatedAt: '',
};

describe('broadcaster', () => {
  it('delivers published events to subscribers and supports unsubscribe', () => {
    const received: unknown[] = [];
    const unsubscribe = broadcaster.subscribe((e) => received.push(e));

    publishIssue(sampleIssue);
    publishOpencodeEvent(1, { kind: 'part', text: 'hi' });

    expect(received).toHaveLength(2);
    expect((received[0] as { type: string }).type).toBe('issue');
    expect((received[1] as { type: string }).type).toBe('opencode-event');

    unsubscribe();
    publishIssue(sampleIssue);
    expect(received).toHaveLength(2);
  });

  it('tracks subscriber count', () => {
    expect(broadcaster.size).toBeGreaterThanOrEqual(0);
  });
});
