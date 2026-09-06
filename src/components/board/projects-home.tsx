'use client';

import { useCallback, useEffect, useState } from 'react';
import { relTime, repoColor } from '@/lib/board-ui';
import type { Project, Topic } from '@/lib/types';
import type { ProjectSummary } from '@/lib/project-status';

interface ProjectsHomeProps {
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  // Bumped by the parent after refresh() and on live issue SSE so the cards
  // stay in sync without their own EventSource.
  refreshKey: number;
}

export function ProjectsHome({ selectedId, onSelect, refreshKey }: ProjectsHomeProps) {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [inbox, setInbox] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ideaFor, setIdeaFor] = useState<number | null>(null);
  const [ideaTitle, setIdeaTitle] = useState('');
  const [ideaBusy, setIdeaBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [newBusy, setNewBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [projRes, inboxRes] = await Promise.all([fetch('/api/projects'), fetch('/api/topics?projectId=null')]);
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects?: ProjectSummary[] };
        if (data.projects) setSummaries(data.projects);
      }
      if (inboxRes.ok) {
        const data = (await inboxRes.json()) as { topics?: Topic[] };
        if (data.topics) setInbox(data.topics.filter((t) => t.status === 'idea'));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
  }, [fetchAll, refreshKey]);

  const addIdea = useCallback(async () => {
    const title = ideaTitle.trim();
    if (!title || ideaFor == null || ideaBusy) return;
    setIdeaBusy(true);
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, projectId: ideaFor }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `add idea failed (HTTP ${res.status})`);
      }
      setIdeaTitle('');
      setIdeaFor(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIdeaBusy(false);
    }
  }, [ideaTitle, ideaFor, ideaBusy, fetchAll]);

  const createProject = useCallback(async () => {
    const name = newName.trim();
    if (!name || newBusy) return;
    setNewBusy(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          serviceRepoOwner: newOwner.trim() || undefined,
          serviceRepoName: newRepo.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `create project failed (HTTP ${res.status})`);
      }
      setNewName('');
      setNewOwner('');
      setNewRepo('');
      setNewOpen(false);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNewBusy(false);
    }
  }, [newName, newOwner, newRepo, newBusy, fetchAll]);

  const assignInbox = useCallback(
    async (topicId: number, projectId: number) => {
      try {
        const res = await fetch(`/api/topics/${topicId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `assign failed (HTTP ${res.status})`);
        }
        await fetchAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [fetchAll]
  );

  return (
    <section className="projects-home" aria-label="Projects">
      {error && (
        <div className="banner" role="alert">
          <span>Projects: {error}</span>
          <button className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {loading ? (
        <div className="empty">loading projects…</div>
      ) : (
        <>
          <div className="projects-grid">
            {summaries.map(({ project, status, needsInput, inFlight, prCount, ideas }) => (
              <ProjectCard
                key={project.id}
                project={project}
                status={status}
                needsInput={needsInput}
                inFlight={inFlight}
                prCount={prCount}
                ideas={ideas}
                selected={selectedId === project.id}
                onSelect={() => onSelect(selectedId === project.id ? null : project.id)}
                ideaOpen={ideaFor === project.id}
                onAddIdea={() => {
                  setIdeaFor(project.id);
                  setIdeaTitle('');
                }}
                ideaTitle={ideaFor === project.id ? ideaTitle : ''}
                onIdeaTitleChange={setIdeaTitle}
                onIdeaSubmit={() => void addIdea()}
                onIdeaCancel={() => {
                  setIdeaFor(null);
                  setIdeaTitle('');
                }}
                ideaBusy={ideaBusy}
              />
            ))}
            <button
              type="button"
              className={`project-card project-card-new${newOpen ? ' open' : ''}`}
              onClick={() => {
                if (!newOpen) setNewOpen(true);
              }}
              aria-expanded={newOpen}
            >
              {newOpen ? (
                <span className="project-new-form" onClick={(e) => e.stopPropagation()}>
                  <span className="project-card-name">+ new project</span>
                  <input
                    className="search"
                    placeholder="Name (e.g. gallery)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <span className="project-new-repo">
                    <input
                      className="search"
                      placeholder="owner (optional)"
                      value={newOwner}
                      onChange={(e) => setNewOwner(e.target.value)}
                    />
                    <input
                      className="search"
                      placeholder="repo (optional)"
                      value={newRepo}
                      onChange={(e) => setNewRepo(e.target.value)}
                    />
                  </span>
                  <span className="project-card-actions">
                    <button
                      type="button"
                      className="card-primary"
                      disabled={!newName.trim() || newBusy}
                      onClick={() => void createProject()}
                    >
                      {newBusy ? 'Creating…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setNewOpen(false);
                        setNewName('');
                        setNewOwner('');
                        setNewRepo('');
                      }}
                    >
                      Cancel
                    </button>
                  </span>
                </span>
              ) : (
                <span className="project-card-name">+ new project</span>
              )}
            </button>
          </div>
          {inbox.length > 0 && (
            <div className="inbox-strip">
              <span className="released-label">Inbox</span>
              <div className="inbox-list">
                {inbox.map((topic) => (
                  <span key={topic.id} className="inbox-item">
                    <span className="released-title">{topic.title}</span>
                    <select
                      className="inbox-assign"
                      defaultValue=""
                      aria-label={`Assign "${topic.title}" to a project`}
                      onChange={(e) => {
                        const pid = Number(e.target.value);
                        if (Number.isInteger(pid) && pid > 0) void assignInbox(topic.id, pid);
                      }}
                    >
                      <option value="" disabled>
                        Assign to…
                      </option>
                      {summaries.map(({ project }) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ProjectCard({
  project,
  status,
  needsInput,
  inFlight,
  prCount,
  ideas,
  selected,
  onSelect,
  ideaOpen,
  onAddIdea,
  ideaTitle,
  onIdeaTitleChange,
  onIdeaSubmit,
  onIdeaCancel,
  ideaBusy,
}: {
  project: Project;
  status: ProjectSummary['status'];
  needsInput: number;
  inFlight: number;
  prCount: number;
  ideas: number;
  selected: boolean;
  onSelect: () => void;
  ideaOpen: boolean;
  onAddIdea: () => void;
  ideaTitle: string;
  onIdeaTitleChange: (v: string) => void;
  onIdeaSubmit: () => void;
  onIdeaCancel: () => void;
  ideaBusy: boolean;
}) {
  const repo = project.serviceRepoOwner && project.serviceRepoName ? `${project.serviceRepoOwner}/${project.serviceRepoName}` : null;
  return (
    <div className={`project-card${selected ? ' selected' : ''}`}>
      <div className="project-card-top" onClick={onSelect} role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        aria-pressed={selected}
        title={selected ? 'Clear project filter' : 'Filter the board to this project'}
      >
        <span className="project-card-name">{project.name}</span>
        <span className={`proj-badge ${status ?? 'stale'}`}>{status ?? 'stale'}</span>
      </div>
      {project.domain && <div className="project-card-domain">{project.domain}</div>}
      <div className="project-card-meta">
        {project.lastShippedTitle ? (
          <span className="project-shipped" title={project.lastShippedAt ?? ''}>
            ✓ {project.lastShippedTitle}
            {project.lastShippedAt ? ` · ${relTime(project.lastShippedAt)}` : ''}
          </span>
        ) : (
          <span className="project-shipped none">nothing shipped yet</span>
        )}
      </div>
      <div className="project-card-counts">
        <span>
          {inFlight} dev · {prCount} pr · {ideas} ideas
        </span>
        {needsInput > 0 && <span className="proj-needs">⚠ {needsInput} needs input</span>}
      </div>
      {repo && (
        <div className="project-card-repos">
          <span className="repo-chip active" style={{ '--chip-color': repoColor(repo) } as React.CSSProperties}>
            <span className="repo-chip-dot" />
            {repo}
          </span>
        </div>
      )}
      {ideaOpen ? (
        <div className="project-idea-form">
          <input
            className="search"
            placeholder="Idea title…"
            value={ideaTitle}
            onChange={(e) => onIdeaTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onIdeaSubmit();
              if (e.key === 'Escape') onIdeaCancel();
            }}
            autoFocus
          />
          <span className="project-card-actions">
            <button type="button" className="card-primary" disabled={!ideaTitle.trim() || ideaBusy} onClick={onIdeaSubmit}>
              {ideaBusy ? 'Saving…' : 'Save idea'}
            </button>
            <button type="button" className="ghost" onClick={onIdeaCancel}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <div className="project-card-actions">
          <button type="button" className="ghost" onClick={onAddIdea}>
            Add idea
          </button>
          <button type="button" className="ghost" onClick={onSelect}>
            {selected ? 'All projects ↑' : 'Board →'}
          </button>
        </div>
      )}
    </div>
  );
}
