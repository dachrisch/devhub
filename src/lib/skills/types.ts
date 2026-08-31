import type { OpencodeEvent, OpencodeModel } from '../opencode';

export type ActionType = 'launch' | 'fix' | 'write' | 'show';

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  action: ActionType;
  triggers: string[];
  requiredParams: string[];
  optionalParams: string[];
}

export interface SkillContext {
  actionId: number;
  input: string;
  params: Record<string, unknown>;
  token: string;
  models: OpencodeModel[];
  onEvent: (event: OpencodeEvent) => void;
  onStatus: (status: string) => void;
  onStartSession: (sessionId: string) => void;
}

export interface SkillResult {
  success: boolean;
  summary: string;
  details?: unknown;
  sessionIds?: string[];
}

export type SkillExecutor = (ctx: SkillContext) => Promise<SkillResult>;
