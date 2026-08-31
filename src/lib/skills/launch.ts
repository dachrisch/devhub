import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { storeKnowledge, upsertService } from '../store';
import { runDevelop } from '../opencode';

const SCAFFOLD_PROMPT = `You are scaffolding a new service called "{name}".

Tech stack: {framework}
Database: {database}

Create the following files in /home/cda/dev/{name}/:
1. Main application file (main.py for Python, main.go for Go, src/index.ts for Node)
2. Dockerfile (multi-stage, production-ready)
3. .gitignore
4. README.md with setup instructions
5. docker-compose.yml for local development
6. requirements.txt / go.mod / package.json as appropriate

Follow these conventions:
- Use non-root user in Dockerfile
- Include health check endpoint at /health
- Expose port 8000 (or appropriate default)
- Use environment variables for configuration

Do NOT create a git repo or push. Just create the files.
End with "SCAFFOLD COMPLETE" when done.`;

const INFRA_PROMPT = `You are adding a new service "{name}" to the servyy-container infrastructure.

Service details:
- Name: {name}
- Framework: {framework}
- Target host: {host}

Create these files:

1. infrastructure/container/{name}/docker-compose.yml
   Follow the exact pattern from devhub's docker-compose.yml:
   - Use {name} as the compose project name
   - Container naming: \${{COMPOSE_PROJECT_NAME}}.web
   - Include env_file, volumes, networks (proxy), healthcheck
   - Add Traefik labels for routing at {name}.{host}
   - Use watchtower label for auto-updates

2. infrastructure/container/ansible/plays/roles/docker_service/templates/{name}/.env.j2
   Template variables: COMPOSE_PROJECT_NAME, SERVICE_NAME, SERVICE_HOST, TRAEFIK_ENTRYPOINT, TRAEFIK_TLS, TRAEFIK_CERTRESOLVER

After creating files, verify they are valid:
- docker-compose config --quiet
- yamllint the files

End with "INFRA COMPLETE" when done.`;

const DEPLOY_PROMPT = `You are deploying the service "{name}" to {host}.

Run these commands:
1. cd /root/dev/infrastructure/container
2. ./servyy.sh --tags user.docker.{name}

If the deploy succeeds, you'll see "changed=0" or "changed=N" with "failed=0".
If it fails, capture the error output.

End with "DEPLOY COMPLETE" or "DEPLOY FAILED: <reason>" when done.`;

registerSkill(
  {
    id: 'launch',
    name: 'Launch Service',
    description: 'Create something new and put it live',
    action: 'launch',
    triggers: ['launch', 'create', 'new', 'scaffold', 'set up', 'deploy'],
    requiredParams: ['name'],
    optionalParams: ['framework', 'database', 'host'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const name = ctx.params.name as string;
    const framework = (ctx.params.framework as string) || 'node';
    const database = (ctx.params.database as string) || 'none';
    const host = (ctx.params.host as string) || 'servy.lehel.xyz';
    const sessionIds: string[] = [];

    // Step 1: Scaffold
    ctx.onStatus(`Creating ${name}...`);

    const scaffoldPrompt = SCAFFOLD_PROMPT
      .replace(/{name}/g, name)
      .replace(/{framework}/g, framework)
      .replace(/{database}/g, database);

    const scaffoldText = await runDevelop(
      scaffoldPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!scaffoldText.includes('SCAFFOLD COMPLETE')) {
      return { success: false, summary: `Scaffolding failed: ${scaffoldText.slice(0, 500)}`, sessionIds };
    }

    // Step 2: Add to infrastructure
    ctx.onStatus('Setting up infrastructure...');

    const infraPrompt = INFRA_PROMPT
      .replace(/{name}/g, name)
      .replace(/{framework}/g, framework)
      .replace(/{host}/g, host);

    const infraText = await runDevelop(
      infraPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!infraText.includes('INFRA COMPLETE')) {
      return { success: false, summary: `Infrastructure setup failed: ${infraText.slice(0, 500)}`, sessionIds };
    }

    // Step 3: Deploy
    ctx.onStatus('Deploying...');

    const deployPrompt = DEPLOY_PROMPT
      .replace(/{name}/g, name)
      .replace(/{host}/g, host);

    const deployText = await runDevelop(
      deployPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!deployText.includes('DEPLOY COMPLETE')) {
      return { success: false, summary: `Deploy failed: ${deployText.slice(0, 500)}`, sessionIds };
    }

    // Step 4: Register and remember
    ctx.onStatus('Registering service...');

    upsertService({
      name,
      deployHost: host,
      deployDir: `/home/cda/dev/${name}`,
      domain: `${name}.${host}`,
      config: { framework, database },
    });

    storeKnowledge('launch',
      `Launched ${name} (${framework}) on ${host}`,
      { name, framework, database, host, steps: ['scaffold', 'infra', 'deploy'] },
      ctx.actionId
    );

    return {
      success: true,
      summary: `${name} is live at ${name}.${host}`,
      sessionIds,
    };
  }
);
