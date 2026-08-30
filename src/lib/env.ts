export interface DevhubEnv {
  opencodeBaseUrl: string;
  opencodeApiKey: string;
  opencodeBasicUser: string;
  opencodeBasicPassword: string;
  ghToken: string;
  bumblefliesGhToken: string;
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
  ghToken: process.env.GH_TOKEN ?? '',
  bumblefliesGhToken: process.env.BUMBLEFLIES_GH_TOKEN ?? '',
  githubTopics: (process.env.GITHUB_TOPICS ?? 'gh-dash,dachrisch,bumbleflies')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  workspaceRoot: process.env.WORKSPACE_ROOT ?? '/home/cda/dev',
  openWorkspaceRoot: process.env.OPENCODE_WORKSPACE_ROOT ?? '/root/dev',
  dbPath: process.env.DEVHUB_DB ?? './devhub.db',
};
