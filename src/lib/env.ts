export interface DevhubEnv {
  opencodeBaseUrl: string;
  opencodeApiKey: string;
  ghToken: string;
  bumblefliesGhToken: string;
  githubTopics: string[];
  workspaceRoot: string;
  dbPath: string;
}

export const ENV: DevhubEnv = {
  opencodeBaseUrl: (process.env.OPENCODE_BASE_URL ?? 'https://code.lehel.xyz').replace(/\/$/, ''),
  opencodeApiKey: process.env.OPENCODE_API_KEY ?? '',
  ghToken: process.env.GH_TOKEN ?? '',
  bumblefliesGhToken: process.env.BUMBLEFLIES_GH_TOKEN ?? '',
  githubTopics: (process.env.GITHUB_TOPICS ?? 'bumbleflies,dachrisch')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  workspaceRoot: process.env.WORKSPACE_ROOT ?? '/home/cda/dev',
  dbPath: process.env.DEVHUB_DB ?? './devhub.db',
};
