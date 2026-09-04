'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IssueState, ModelOption } from '@/lib/types';

export interface UseCardActionsOptions {
  // Called once the server accepted a develop start (202) — the run is now
  // owned by the server and its state arrives via SSE.
  onStarted?: () => void;
  // Called when the start request failed so any optimistic "just started"
  // UI can be rolled back and the Work button restored.
  onStartFailed?: () => void;
}

export interface UseCardActionsResult {
  busy: boolean;
  error: string | null;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  command: string;
  setCommand: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  setSelectedModel: (model: ModelOption | null) => void;
  start: () => Promise<void>;
  transition: (target: IssueState) => Promise<void>;
}

export function useCardActions(issueId: number, options: UseCardActionsOptions = {}): UseCardActionsResult {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  // Latest callbacks without re-creating `start` on every render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = (await res.json()) as { models: ModelOption[]; default: ModelOption | null };
      setModels(data.models ?? []);
      setSelectedModel(data.default ?? null);
    } catch {
      /* non-fatal: fall back to no override */
    }
  }, []);

  const openModal = useCallback(() => {
    setModalOpen(true);
    void loadModels();
  }, [loadModels]);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: { command: string; modelId?: string; providerID?: string } = {
        command,
      };
      if (selectedModel) {
        body.modelId = selectedModel.id;
        body.providerID = selectedModel.providerID;
      }
      const res = await fetch(`/api/issues/${issueId}/develop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const data = (await res.json()) as { error?: string };
          detail = data.error ?? '';
        } catch { /* non-JSON */ }
        setError(detail || `develop failed (HTTP ${res.status})`);
        optionsRef.current.onStartFailed?.();
        return;
      }
      setModalOpen(false);
      optionsRef.current.onStarted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      optionsRef.current.onStartFailed?.();
    } finally {
      setBusy(false);
    }
  }, [issueId, command, selectedModel]);

  const transition = useCallback(
    async (target: IssueState) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/issues/${issueId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: target }),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const data = (await res.json()) as { error?: string };
            detail = data.error ?? '';
          } catch { /* non-JSON */ }
          setError(detail || `transition failed (HTTP ${res.status})`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [issueId]
  );

  return {
    busy,
    error,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
    transition,
  };
}
