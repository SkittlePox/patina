import * as vscode from 'vscode';
import { LineMark, READ } from './core/marks';
import { compileExcludes } from './core/glob';
import { DEFAULT_PALETTE, PALETTES, ResolvedColors, resolveColors } from './core/palettes';
import { DAY_MS } from './core/time';

export interface CategoryDef {
  id: string;
  label: string;
}

export type HighlightStyle = 'background' | 'gutter' | 'gutterAndBackground';
const HIGHLIGHT_STYLES: HighlightStyle[] = ['background', 'gutter', 'gutterAndBackground'];

export type FoldSummaryMode = 'always' | 'cursorLine' | 'off';
const FOLD_SUMMARY_MODES: FoldSummaryMode[] = ['always', 'cursorLine', 'off'];

export const DEFAULT_FOLD_SUMMARY_FORMAT = [
  'Contents: {readPercent}% read',
  'read on average {readAge} ago',
  '{edited:line} edited, most recently {editedNewest} ago',
  '{categories}',
  '⚠ {stale} changed outside editor',
];

export interface PatinaConfig {
  readLabel: string;
  fadeMs: number;
  /** Static categories (not `read`), in settings order. */
  categories: Map<string, CategoryDef>;
  /** Final background and gutter colors: palette plus any overrides. */
  colors: ResolvedColors;
  showCursorLineAnnotation: boolean;
  /** Where to show a summary of a folded block's marks at the end of its first line. */
  foldSummary: FoldSummaryMode;
  /** Segments of the folded-block summary, with `{placeholder}`s. */
  foldSummaryFormat: string[];
  /** While a block is folded, tint its first line with the average color of the lines in it. */
  foldHighlight: boolean;
  /** Template for a folded block's first-line label in the cursor-line note; `{label}` is the mark's label. */
  foldLineLabel: string;
  showInOverviewRuler: boolean;
  highlightStyle: HighlightStyle;
  explorerEnabled: boolean;
  storageFile: string;
  /** Whether a workspace-relative path is excluded by `patina.exclude`. */
  isExcluded: (relPath: string) => boolean;
}

const FALLBACK_COLOR = 'rgba(128, 128, 128, 0.15)';

export function readConfig(): PatinaConfig {
  const c = vscode.workspace.getConfiguration('patina');
  const categories = new Map<string, CategoryDef>();
  const categoryColors: { id: string; color?: string; gutterColor?: string }[] = [];
  const raw = c.get<Record<string, { label?: string; color?: string; gutterColor?: string }>>('categories') ?? {};
  for (const [id, def] of Object.entries(raw)) {
    if (id === READ || !def) continue;
    categories.set(id, { id, label: def.label || id });
    categoryColors.push({ id, color: def.color, gutterColor: def.gutterColor });
  }
  const paletteSetting = c.get<string>('palette') ?? '';
  const palette = paletteSetting in PALETTES ? paletteSetting : DEFAULT_PALETTE;
  const colors = resolveColors(palette, {
    readFade: c.get<string[]>('read.fadeColors'),
    readFadeGutter: c.get<string[]>('read.gutterFadeColors'),
    stale: c.get<string>('stale.color'),
    staleGutter: c.get<string>('stale.gutterColor'),
    categories: categoryColors,
  });
  return {
    readLabel: c.get<string>('read.label') || 'Read',
    fadeMs: Math.max(0.01, c.get<number>('read.fadeDays') ?? 30) * DAY_MS,
    categories,
    colors,
    showCursorLineAnnotation: c.get<boolean>('showCursorLineAnnotation') ?? false,
    foldSummary: FOLD_SUMMARY_MODES.find((m) => m === c.get<string>('foldSummary.show')) ?? 'always',
    foldSummaryFormat: foldSummaryFormat(c.get<unknown>('foldSummary.format')),
    foldHighlight: c.get<boolean>('foldSummary.highlight') ?? true,
    foldLineLabel: c.get<string>('foldSummary.lineLabel') ?? 'Line {label}',
    showInOverviewRuler: c.get<boolean>('showInOverviewRuler') ?? true,
    highlightStyle: HIGHLIGHT_STYLES.find((h) => h === c.get<string>('highlightStyle')) ?? 'background',
    explorerEnabled: c.get<boolean>('explorer.enabled') ?? true,
    storageFile: c.get<string>('storageFile') || '.vscode/patina.json',
    isExcluded: compileExcludes(c.get<string[]>('exclude') ?? []),
  };
}

function foldSummaryFormat(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    const list = raw.filter((x): x is string => typeof x === 'string');
    if (list.length > 0) return list;
  }
  return DEFAULT_FOLD_SUMMARY_FORMAT;
}

/** Label for a specific mark: read marks created by typing show as "Edited". */
export function markLabel(cfg: PatinaConfig, m: LineMark): string {
  return m.cat === READ && m.edited ? 'Edited' : categoryLabel(cfg, m.cat);
}

export function categoryLabel(cfg: PatinaConfig, cat: string): string {
  if (cat === READ) return cfg.readLabel;
  return cfg.categories.get(cat)?.label ?? cat;
}

export { FALLBACK_COLOR };
