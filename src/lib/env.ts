export interface DevhubEnv {
  opencodeBaseUrl: string;
  opencodeApiKey: string;
  opencodeBasicUser: string;
  opencodeBasicPassword: string;
  opencodePollTimeoutMs: number;
  opencodeRefinementPollTimeoutMs: number;
  githubClientId: string;
  githubClientSecret: string;
  githubRedirectUri: string;
  githubAllowedOrg: string;
  githubTopics: string[];
  workspaceRoot: string;
  openWorkspaceRoot: string;
  dbPath: string;
}

export const ENV: DevhubEnv = {
  opencodeBaseUrl: (process.env.OPENCODE_BASE_URL ?? 'https://code.lehel.xyz').replace(/\/$/, ''),
  opencodeApiKey: process.env.OPENCODE_API_KEY ?? '',
  opencodeBasicUser: process.env.OPENCODE_BASIC_USER ?? 'opencode',
  opencodeBasicPassword: process.env.OPENCODE_BASIC_PASSWORD ?? '',
  // A full agentic coding+PR run routinely takes 15+ minutes; the old 120s
  // budget made every real develop run "time out" and churn new sessions.
  opencodePollTimeoutMs: parsePositiveInt(process.env.OPENCODE_POLL_TIMEOUT_MS, 30 * 60 * 1000),
  // The refinement assessment is a short JSON-only reply, not an agentic run;
  // a dead model (admitted prompt, server-side failure with no message row)
  // must surface within minutes, not after the full 30-minute develop budget.
  opencodeRefinementPollTimeoutMs: parsePositiveInt(
    process.env.OPENCODE_REFINEMENT_POLL_TIMEOUT_MS,
    10 * 60 * 1000
  ),
  githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  githubRedirectUri: process.env.GITHUB_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback',
  githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG ?? 'bumbleflies',
  githubTopics: (process.env.GITHUB_TOPICS ?? 'gh-dash,dachrisch,bumbleflies')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  workspaceRoot: process.env.WORKSPACE_ROOT ?? '/home/cda/dev',
  openWorkspaceRoot: process.env.OPENCODE_WORKSPACE_ROOT ?? '/root/dev',
  dbPath: process.env.DEVHUB_DB ?? './devhub.db',
};

// Parses an env var as a positive integer (ms); falls back to `fallback`.
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}