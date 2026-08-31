'use client';

import { useCallback, useState } from 'react';
import type { IssueState, ModelOption } from '@/lib/types';

export interface UseCardActionsResult {
  busy: boolean;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  command: string;
  setCommand: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  setSelectedModel: (model: ModelOption | null) => void;
  develop: () => Promise<void>;
  stagedDevelop: () => Promise<void>;
  transition: (target: IssueState) => Promise<void>;
}

export function useCardActions(issueId: number): UseCardActionsResult {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);

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

  const postDevelop = useCallback(
    async (staged: boolean) => {
      setBusy(true);
      try {
        const body: { command: string; modelId?: string; providerID?: string; staged?: boolean } = {
          command,
        };
        if (staged) body.staged = true;
        if (selectedModel) {
          body.modelId = selectedModel.id;
          body.providerID = selectedModel.providerID;
        }
        await fetch(`/api/issues/${issueId}/develop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setModalOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [issueId, command, selectedModel]
  );

  const develop = useCallback(() => postDevelop(false), [postDevelop]);
  const stagedDevelop = useCallback(() => postDevelop(true), [postDevelop]);

  const transition = useCallback(
    async (target: IssueState) => {
      setBusy(true);
      try {
        await fetch(`/api/issues/${issueId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: target }),
        });
      } finally {
        setBusy(false);
      }
    },
    [issueId]
  );

  return {
    busy,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  };
}
