import {
  getActiveTopicsForProject,
  getIssuesByProject,
  getProject,
  getRunsForIssue,
  getTopics,
  setProjectStatus,
  type Issue,
  type Project,
  type ProjectStatus,
  type Topic,
} from './store';

// "healthy" = no active work but something shipped recently.
const HEALTHY_WINDOW_DAYS = 14;

export interface ProjectSummary {
  project: Project;
  status: ProjectStatus;
  // Runs (or legacy issues) sitting blocked, waiting for operator input.
  needsInput: number;
  // Non-blocked developing/pr/merged work.
  inFlight: number;
  // Open PRs (subset of inFlight shown separately on the card).
  prCount: number;
  // Topic ideas attached to the project (new|shaping|ready|realizing).
  ideas: number;
  // Top recent ideas for the inline Ideas section on the home card.
  recentIdeas: Topic[];
}

const ACTIVE_RUN_STATES = new Set(['developing', 'pr', 'merged']);
const SHIPPED_RUN_STATES = new Set(['released']);

function summarizeIssue(issue: Issue): { active: number; needsInput: number; pr: number; shipped: number } {
  const runs = getRunsForIssue(issue.id);
  if (runs.length > 0) {
    let active = 0;
    let needsInput = 0;
    let pr = 0;
    let shipped = 0;
    for (const run of runs) {
      const blocked = run.state === 'failed' || (run.state === 'developing' && run.blockedReason);
      if (blocked) needsInput += 1;
      else if (ACTIVE_RUN_STATES.has(run.state)) {
        active += 1;
        if (run.state === 'pr') pr += 1;
      } else if (SHIPPED_RUN_STATES.has(run.state)) shipped += 1;
    }
    return { active, needsInput, pr, shipped };
  }
  // Legacy path: issues created before run tracking; state lives on the issue.
  const blocked = issue.state === 'developing' && issue.blockedReason;
  if (blocked) return { active: 0, needsInput: 1, pr: 0, shipped: 0 };
  if (issue.state === 'developing' || issue.state === 'pr') return { active: 1, needsInput: 0, pr: issue.state === 'pr' ? 1 : 0, shipped: 0 };
  if (issue.state === 'rollout') return { active: 0, needsInput: 0, pr: 0, shipped: 1 };
  return { active: 0, needsInput: 0, pr: 0, shipped: 0 };
}

// The override always wins; otherwise in-flight > healthy > stale.
export function deriveProjectStatus(project: Project): ProjectStatus {
  if (project.statusOverride) return project.statusOverride;
  const issues = getIssuesByProject(project.id);
  for (const issue of issues) {
    const s = summarizeIssue(issue);
    if (s.active > 0) return 'in-flight';
  }
  if (project.lastShippedAt) {
    const ageMs = Date.now() - new Date(project.lastShippedAt + 'Z').getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= HEALTHY_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return 'healthy';
    }
  }
  return 'stale';
}

// Aggregates everything the home card renders, and refreshes the project's
// cached derived status when it moved.
export function summarizeProject(project: Project): ProjectSummary {
  const issues = getIssuesByProject(project.id);
  let needsInput = 0;
  let inFlight = 0;
  let prCount = 0;
  for (const issue of issues) {
    const s = summarizeIssue(issue);
    needsInput += s.needsInput;
    inFlight += s.active;
    prCount += s.pr;
  }
  const recentIdeas = getActiveTopicsForProject(project.id, 3);
  const ideas =
    getTopics({ projectId: project.id, status: 'new' }).length +
    getTopics({ projectId: project.id, status: 'shaping' }).length +
    getTopics({ projectId: project.id, status: 'ready' }).length +
    getTopics({ projectId: project.id, status: 'realizing' }).length;
  const status = deriveProjectStatus(project);
  if (status !== project.status) setProjectStatus(project.id, status);
  return { project: getProject(project.id) ?? project, status, needsInput, inFlight, prCount, ideas, recentIdeas };
}
