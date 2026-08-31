import type { SkillManifest, SkillExecutor, ActionType } from './types';

interface RegisteredSkill {
  manifest: SkillManifest;
  execute: SkillExecutor;
}

const registry: RegisteredSkill[] = [];

export function registerSkill(manifest: SkillManifest, execute: SkillExecutor): void {
  registry.push({ manifest, execute });
}

export function loadSkills(): SkillManifest[] {
  return registry.map((s) => s.manifest);
}

export function getByAction(action: ActionType): RegisteredSkill | null {
  return registry.find((s) => s.manifest.action === action) ?? null;
}

export function getSkillById(id: string): RegisteredSkill | null {
  return registry.find((s) => s.manifest.id === id) ?? null;
}
