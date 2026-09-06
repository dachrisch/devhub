import { describe, expect, it } from 'vitest';
import { broadcaster, publishAction, publishProject, publishRun, publishTopic } from './sse';

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
});
