import type { IdeaMessage, Issue, TopicStatus } from './types';
import type { OpencodeEvent } from './opencode';

export type ServerEvent =
  | { type: 'issue'; issue: Issue }
  | { type: 'opencode-event'; issueId: number; event: OpencodeEvent }
  | { type: 'action'; actionId: number; status: string; detail: string }
  // Project cockpit (devhub#167): id-notifications, mirroring the `action`
  // pattern — the client hydrates via GET /api/projects + /api/topics. Run
  // events land with the Phase 3 orchestration; the helper ships now.
  | { type: 'project'; projectId: number }
  | { type: 'topic'; topicId: number }
  | { type: 'run'; runId: number; issueId: number }
  // Ideas-first shaping loop (devhub#171 Phase 2): the idea page hydrates the
  // thread via GET /api/topics/[id]/messages on these notifications.
  | { type: 'idea-message'; topicId: number; messageId: number }
  | { type: 'idea-status'; topicId: number; status: TopicStatus }
  // Command-first threads (v2): id-notifications, mirroring the `action`
  // pattern — the client hydrates via GET /api/threads[/id].
  | { type: 'thread'; threadId: number }
  | { type: 'thread-event'; threadId: number }
  // Agent Activity (devhub#270): a batch landed or a source heartbeat arrived.
  // The /activity page refetches GET /api/activity on these notifications.
  | { type: 'activity'; source: string }
  | { type: 'activity-heartbeat'; source: string }
  | { type: 'hello'; now: string };

type Listener = (event: ServerEvent) => void;

class Broadcaster {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

// Persist across Next.js dev HMR reloads.
const globalForBroadcaster = globalThis as unknown as { __devhubBroadcaster?: Broadcaster };
export const broadcaster: Broadcaster = globalForBroadcaster.__devhubBroadcaster ?? (globalForBroadcaster.__devhubBroadcaster = new Broadcaster());

export function publishIssue(issue: Issue): void {
  broadcaster.publish({ type: 'issue', issue });
}

export function publishOpencodeEvent(issueId: number, event: OpencodeEvent): void {
  broadcaster.publish({ type: 'opencode-event', issueId, event });
}

export function publishAction(actionId: number, status: string, detail: string): void {
  broadcaster.publish({ type: 'action', actionId, status, detail });
}

export function publishProject(projectId: number): void {
  broadcaster.publish({ type: 'project', projectId });
}

export function publishTopic(topicId: number): void {
  broadcaster.publish({ type: 'topic', topicId });
}

export function publishIdeaMessage(topicId: number, message: IdeaMessage): void {
  broadcaster.publish({ type: 'idea-message', topicId, messageId: message.id });
}

export function publishIdeaStatus(topicId: number, status: TopicStatus): void {
  broadcaster.publish({ type: 'idea-status', topicId, status });
}

export function publishRun(runId: number, issueId: number): void {
  broadcaster.publish({ type: 'run', runId, issueId });
}

export function publishThread(threadId: number): void {
  broadcaster.publish({ type: 'thread', threadId });
}

export function publishThreadEvent(threadId: number): void {
  broadcaster.publish({ type: 'thread-event', threadId });
}

export function publishActivity(source: string): void {
  broadcaster.publish({ type: 'activity', source });
}

export function publishActivityHeartbeat(source: string): void {
  broadcaster.publish({ type: 'activity-heartbeat', source });
}
