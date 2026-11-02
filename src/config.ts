import * as vscode from 'vscode';
import { READ } from './core/marks';
import { DAY_MS } from './core/time';

export interface CategoryDef {
  id: string;
  label: string;
  color: string;
}

export interface PatinaConfig {
  readLabel: string;
  fadeColors: string[];
  fadeMs: number;
  staleColor: string;
  categories: Map<string, CategoryDef>;
  showCursorLineAnnotation: boolean;
  showInOverviewRuler: boolean;
  explorerEnabled: boolean;
  storageFile: string;
}

const FALLBACK_COLOR = 'rgba(128, 128, 128, 0.15)';

export function readConfig(): PatinaConfig {
  const c = vscode.workspace.getConfiguration('patina');
  const categories = new Map<string, CategoryDef>();
  const raw = c.get<Record<string, { label?: string; color?: string }>>('categories') ?? {};
  for (const [id, def] of Object.entries(raw)) {
    if (id === READ || !def) continue;
    categories.set(id, { id, label: def.label || id, color: def.color || FALLBACK_COLOR });
  }
  const fadeColors = c.get<string[]>('read.fadeColors') ?? [];
  return {
    readLabel: c.get<string>('read.label') || 'Read',
    fadeColors: fadeColors.length ? fadeColors : ['rgba(46, 160, 67, 0.24)'],
    fadeMs: Math.max(0.01, c.get<number>('read.fadeDays') ?? 30) * DAY_MS,
    staleColor: c.get<string>('stale.color') || 'rgba(230, 60, 60, 0.28)',
    categories,
    showCursorLineAnnotation: c.get<boolean>('showCursorLineAnnotation') ?? false,
    showInOverviewRuler: c.get<boolean>('showInOverviewRuler') ?? true,
    explorerEnabled: c.get<boolean>('explorer.enabled') ?? true,
    storageFile: c.get<string>('storageFile') || '.vscode/patina.json',
  };
}

export function categoryLabel(cfg: PatinaConfig, cat: string): string {
  if (cat === READ) return cfg.readLabel;
  return cfg.categories.get(cat)?.label ?? cat;
}

export { FALLBACK_COLOR };
