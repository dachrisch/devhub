export interface DevhubEnv {
  opencodeBaseUrl: string;
  opencodeApiKey: string;
  opencodeBasicUser: string;
  opencodeBasicPassword: string;
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