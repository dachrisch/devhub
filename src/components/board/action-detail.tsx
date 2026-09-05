'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelOption } from '@/lib/types';
import { statusLabel, fmtDuration } from '@/components/board/action-status-strip';

// Full detail view for one cockpit action: the only place where the prompt,
// the result/error and the live opencode transcript are fully readable.
// Shell is breakpoint-adaptive (CSS-only difference):
//   mobile  → near-full-height bottom sheet (over a dimmed backdrop)
//   desktop → right-side drawer that leaves the board usable
//
// Data: the full row from GET /api/action/[id] (including the transcript,
// persisted ~1/s while the run is live) + the page's live SSE state for
// status/detail. Re-polled every couple of seconds while the action runs so
// the transcript keeps rolling; one final poll when it turns terminal.

interface ActionDetailRow {
  id: number;
  input: string;
  status: string;
  result: string | null;
  sessionIds: string;
  transcript: string | null;
  durationMs: number | null;
  params: string;
}

interface ActionDetailProps {
  actionId: number;
  liveStatus: string | null;
  liveDetail: string | null;
  isMobile: boolean;
  onClose: () => void;
  // Rerun with adjusted prompt: terminal-state actions only. `model` is the
  // override the action ran with (may be null = default chain).
  onRerun: (input: string, model: ModelOption | null, retryOf: number) => void;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseModel(params: string | null): ModelOption | null {
  if (!params) return null;
  try {
    const p = JSON.parse(params) as { modelId?: unknown; providerID?: unknown };
    if (typeof p.modelId === 'string' && typeof p.providerID === 'string') {
      return { id: p.modelId, providerID: p.providerID };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function ActionDetail({
  actionId,
  liveStatus,
  liveDetail,
  isMobile,
  onClose,
  onRerun,
}: ActionDetailProps) {
  const [loaded, setLoaded] = useState<ActionDetailRow | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = liveStatus ?? loaded?.status ?? 'pending';
  const terminal = status === 'success' || status === 'failed';
  // Reset-on-switch without setState in effects: a row only renders while its
  // id matches the open action, so switching ids never flashes stale data.
  const row = loaded && loaded.id === actionId ? loaded : null;

  const fetchRow = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/action/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as { action?: ActionDetailRow };
      if (data.action && data.action.id === id) setLoaded(data.action);
    } catch {
      /* ignore */
    }
  }, []);

  // Poll the row: immediately on open/switch, every couple of seconds while
  // the run is live (transcript flushes ~1/s server-side), and one catch-up
  // poll when the status turns terminal. setLoaded runs in async callbacks.
  useEffect(() => {
    stickToBottomRef.current = true;
    let cancelled = false;
    const poll = () => {
      if (!cancelled) void fetchRow(actionId);
    };
    const initial = setTimeout(poll, 0);
    const interval = terminal ? undefined : setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  }, [actionId, terminal, fetchRow]);

  // Escape closes (backdrop tap/×/drawer's close button handle the rest).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Stick-to-bottom transcript: follow new lines unless the user scrolled up.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  }, []);

  const copy = useCallback(async (field: string, text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(field);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const model = parseModel(row?.params ?? null);
  const sessions = parseJsonArray(row?.sessionIds ?? null);
  const inputText = row?.input ?? '';
  const resultText = row?.result ?? null;
  const transcriptText = row?.transcript ?? '';
  const detailLine = liveDetail ?? resultText;

  const body = (
    <>
      <div className="action-detail-head">
        <span className="action-detail-title">Action #{actionId}</span>
        <span className={`action-detail-status ${status}`}>{statusLabel(status)}</span>
        <button type="button" className="header-icon-btn" onClick={onClose} aria-label="Close action detail">
          ×
        </button>
      </div>
      <div className="action-detail-body">
        <div className="action-detail-meta">
          {row?.durationMs != null && <span>{statusLabel(status)} in {fmtDuration(row.durationMs)}</span>}
          <span>Model: {model ? `${model.id} (${model.providerID})` : 'default tiers'}</span>
        </div>

        <section className="action-detail-section">
          <div className="action-detail-label-row">
            <span className="action-detail-label">Prompt</span>
            {inputText && (
              <button type="button" className="copy-btn" onClick={() => void copy('input', inputText)}>
                {copied === 'input' ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <div className="action-detail-text">{inputText || '…'}</div>
        </section>

        {detailLine && (
          <section className="action-detail-section">
            <div className="action-detail-label-row">
              <span className="action-detail-label">{status === 'failed' ? 'Error' : 'Result'}</span>
              <button type="button" className="copy-btn" onClick={() => void copy('result', detailLine)}>
                {copied === 'result' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className={`action-detail-text ${status === 'failed' ? 'error' : ''}`}>{detailLine}</div>
          </section>
        )}

        {transcriptText && (
          <section className="action-detail-section">
            <div className="action-detail-label-row">
              <span className="action-detail-label">Transcript{terminal ? '' : ' (live)'}</span>
              <button type="button" className="copy-btn" onClick={() => void copy('transcript', transcriptText)}>
                {copied === 'transcript' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="action-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
              <div className="action-detail-text">{transcriptText}</div>
            </div>
          </section>
        )}

        {sessions.length > 0 && (
          <section className="action-detail-section">
            <div className="action-detail-label-row">
              <span className="action-detail-label">Opencode sessions</span>
              <button
                type="button"
                className="copy-btn"
                onClick={() => void copy('sessions', sessions.join('\n'))}
              >
                {copied === 'sessions' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="action-detail-text">{sessions.join('\n')}</div>
          </section>
        )}
      </div>
      {terminal && (
        <div className="action-detail-actions">
          <button
            type="button"
            className="develop-btn"
            onClick={() => onRerun(inputText, model, actionId)}
            disabled={!inputText}
          >
            Rerun with adjusted prompt
          </button>
        </div>
      )}
    </>
  );

  if (isMobile) {
    return (
      <div className="action-detail-backdrop" onClick={onClose}>
        <div
          className="action-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`Action #${actionId} detail`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="card-sheet-handle" />
          {body}
        </div>
      </div>
    );
  }
  return (
    <aside className="action-drawer" role="dialog" aria-label="Cockpit action detail">
      {body}
    </aside>
  );
}
