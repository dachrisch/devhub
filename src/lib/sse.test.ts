import { describe, expect, it } from 'vitest';
import { broadcaster, publishAction, publishIdeaMessage, publishIdeaStatus, publishProject, publishRun, publishTopic } from './sse';

describe('sse', () => {
  it('publishes action events', () => {
    const events: unknown[] = [];
    const unsub = broadcaster.subscribe((e) => events.push(e));
    publishAction(42, 'running', 'Scaffolding...');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'action', actionId: 42, status: 'running', detail: 'Scaffolding...' });
    unsub();
  });

  it('publishes project/topic/run id-notifications', () => {
    const events: unknown[] = [];
    const unsub = broadcaster.subscribe((e) => events.push(e));
    publishProject(3);
    publishTopic(7);
    publishRun(9, 11);
    expect(events).toEqual([
      { type: 'project', projectId: 3 },
      { type: 'topic', topicId: 7 },
      { type: 'run', runId: 9, issueId: 11 },
    ]);
    unsub();
  });

  it('publishes idea-message/idea-status shaping notifications (devhub#171)', () => {
    const events: unknown[] = [];
    const unsub = broadcaster.subscribe((e) => events.push(e));
    publishIdeaMessage(5, { id: 9, topicId: 5, role: 'assistant', body: 'Which way?', options: null, chosenOption: null, createdAt: 'now' });
    publishIdeaStatus(5, 'ready');
    expect(events).toEqual([
      { type: 'idea-message', topicId: 5, messageId: 9 },
      { type: 'idea-status', topicId: 5, status: 'ready' },
    ]);
    unsub();
  });
});
