// Agent Activity contract (devhub#270 / #271). The devhub-owned receiving
// side; the setup-home `agent-relay` producer mirrors these shapes.

export type ActivityHarness = 'claude' | 'opencode';

export type ActivityStatus = 'working' | 'needs-input' | 'idle' | 'done' | 'error';

// Cost provenance is per source and must never be summed across kinds:
// opencode reports cost; Claude is estimated from a local price table.
export type CostKind = 'reported' | 'estimated';

export interface ActivityTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsed?: number;
  contextLimit?: number;
}

// One session in an ingest batch (producer-owned payload).
export interface IngestSession {
  harness: ActivityHarness;
  sessionId: string;
  project?: string | null;
  repo?: string | null;
  branch?: string | null;
  model?: string | null;
  agent?: string | null;
  status: ActivityStatus;
  activity?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  tokens?: ActivityTokens;
  cost?: number | null;
  costKind?: CostKind;
  messages?: number;
  toolCalls?: number;
}

export interface IngestEvent {
  sessionId: string;
  ts: number;
  type: string;
  tool?: string | null;
  text?: string | null;
}

// A full ingest batch. Every batch is also a liveness heartbeat for `source`;
// there is no separate heartbeat field.
export interface IngestBatch {
  source: string;
  sentAt?: number;
  sessions?: IngestSession[];
  events?: IngestEvent[];
  // Optional producer-side aggregates (e.g. Claude stats-cache). Opaque here;
  // stored on activity_source and rolled up in devhub#273.
  history?: unknown;
}

// Persisted current per-session state (activity_session).
export interface ActivitySession {
  source: string;
  sessionId: string;
  harness: ActivityHarness;
  project: string | null;
  repo: string | null;
  branch: string | null;
  model: string | null;
  agent: string | null;
  status: ActivityStatus;
  activity: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  tokens: ActivityTokens;
  cost: number | null;
  costKind: CostKind;
  messages: number;
  toolCalls: number;
  client: string | null;
  issueId: number | null;
  attribution: unknown | null;
  lastSeen: string;
}

export interface ActivityEvent {
  id: number;
  source: string;
  sessionId: string;
  ts: number;
  type: string;
  tool: string | null;
  text: string | null;
}

export interface ActivitySourceState {
  source: string;
  lastHeartbeat: string | null;
  sentAt: number | null;
  lastCursor: string | null;
  history: unknown | null;
}

// Durable usage rollups (devhub#273). Cost provenance stays split.
export interface UsageBucket {
  key: string;
  sessions: number;
  tokens: number;
  costReported: number;
  costEstimated: number;
}

export interface UsageHistory {
  days: UsageBucket[];
  clients: UsageBucket[];
  projects: UsageBucket[];
  models: UsageBucket[];
}
