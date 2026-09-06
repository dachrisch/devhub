import type { Issue } from './types';
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

export function publishRun(runId: number, issueId: number): void {
  broadcaster.publish({ type: 'run', runId, issueId });
}
