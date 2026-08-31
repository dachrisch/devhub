import { describe, expect, it } from 'vitest';
import { broadcaster, publishAction } from './sse';

describe('sse', () => {
  it('publishes action events', () => {
    const events: unknown[] = [];
    const unsub = broadcaster.subscribe((e) => events.push(e));
    publishAction(42, 'running', 'Scaffolding...');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'action', actionId: 42, status: 'running', detail: 'Scaffolding...' });
    unsub();
  });
});
