import { formatColor, parseColor, withMinAlpha } from './color';

/** Colors for one rendering surface (line background or gutter bar). */
export interface ColorSet {
  /** Read-mark fade stops, from just-read to fully faded. */
  readFade: string[];
  stale: string;
  /** Colors for the built-in categories, by id. */
  categories: Record<string, string>;
  /** Assigned in order to user-defined categories that have no color of their own. */
  extra: string[];
}

export interface Palette {
  label: string;
  description: string;
  background: ColorSet;
  gutter: ColorSet;
}

type RGB = [number, number, number];

const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Builds a palette from hues: translucent backgrounds, near-opaque gutter bars. */
function palette(
  label: string,
  description: string,
  hues: { fade: RGB[]; stale: RGB; next: RGB; question: RGB; extra: RGB[] },
  alpha: { bg: number; bgFaded: number; bar: number; barFaded: number },
): Palette {
  const fade = (a: number, faded: number) =>
    hues.fade.map((h, i) => rgba(h, +(a + ((faded - a) * i) / Math.max(1, hues.fade.length - 1)).toFixed(3)));
  const set = (a: number, faded: number): ColorSet => ({
    readFade: fade(a, faded),
    stale: rgba(hues.stale, +Math.min(1, a * 1.2).toFixed(3)),
    categories: { next: rgba(hues.next, a), question: rgba(hues.question, a) },
    extra: hues.extra.map((h) => rgba(h, a)),
  });
  return { label, description, background: set(alpha.bg, alpha.bgFaded), gutter: set(alpha.bar, alpha.barFaded) };
}

const GRAY: RGB = [128, 128, 128];

export const PALETTES: Record<string, Palette> = {
  default: palette(
    'Default',
    'Green → yellow → gray for read, red for stale, blue/purple categories.',
    {
      fade: [[46, 160, 67], [210, 180, 40], GRAY],
      stale: [230, 60, 60],
      next: [64, 140, 255],
      question: [180, 90, 255],
      extra: [[255, 150, 0], [0, 180, 170], [230, 80, 160]],
    },
    { bg: 0.22, bgFaded: 0.12, bar: 0.9, barFaded: 0.55 },
  ),
  muted: palette(
    'Muted',
    'Soft, low-contrast tones that stay out of the way.',
    {
      fade: [[120, 170, 120], [195, 180, 125], GRAY],
      stale: [200, 105, 105],
      next: [110, 140, 200],
      question: [160, 130, 200],
      extra: [[205, 155, 105], [105, 170, 165], [195, 125, 165]],
    },
    { bg: 0.16, bgFaded: 0.08, bar: 0.7, barFaded: 0.4 },
  ),
  supermuted: palette(
    'Super muted',
    'Barely-there tints, close to gray; for when the marks should stay in the background.',
    {
      fade: [[130, 155, 130], [160, 155, 130], GRAY],
      stale: [180, 115, 115],
      next: [125, 140, 170],
      question: [150, 135, 170],
      extra: [[170, 150, 125], [125, 155, 150], [165, 135, 150]],
    },
    { bg: 0.09, bgFaded: 0.05, bar: 0.45, barFaded: 0.25 },
  ),
  vivid: palette(
    'Vivid',
    'Saturated, high-contrast colors.',
    {
      fade: [[0, 200, 80], [255, 190, 0], GRAY],
      stale: [255, 40, 40],
      next: [0, 120, 255],
      question: [200, 0, 255],
      extra: [[255, 120, 0], [0, 200, 200], [255, 0, 150]],
    },
    { bg: 0.3, bgFaded: 0.14, bar: 1, barFaded: 0.6 },
  ),
  colorblind: palette(
    'Colorblind-safe',
    'Okabe–Ito colors: blue → sky → gray for read, vermillion for stale; no red/green distinctions.',
    {
      fade: [[0, 114, 178], [86, 180, 233], GRAY],
      stale: [213, 94, 0],
      next: [0, 158, 115],
      question: [204, 121, 167],
      extra: [[230, 159, 0], [240, 228, 66], [0, 0, 0]],
    },
    { bg: 0.24, bgFaded: 0.12, bar: 0.9, barFaded: 0.55 },
  ),
};

export const DEFAULT_PALETTE = 'supermuted';
const FALLBACK = 'rgba(128, 128, 128, 0.15)';
/** A background override without a gutter override gets this minimum opacity in the gutter. */
const DERIVED_GUTTER_MIN_ALPHA = 0.85;

/** User color settings. Empty / undefined means "use the palette". */
export interface ColorOverrides {
  readFade?: string[];
  readFadeGutter?: string[];
  stale?: string;
  staleGutter?: string;
  /** In settings order. */
  categories: { id: string; color?: string; gutterColor?: string }[];
}

export interface ResolvedSet {
  readFade: string[];
  stale: string;
  categories: Map<string, string>;
}

export interface ResolvedColors {
  background: ResolvedSet;
  gutter: ResolvedSet;
}

function strengthen(color: string): string {
  const p = parseColor(color);
  return p ? formatColor(withMinAlpha(p, DERIVED_GUTTER_MIN_ALPHA)) : color;
}

const nonEmpty = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
const nonEmptyList = (l: string[] | undefined) => {
  const list = (l ?? []).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
};

/**
 * Final colors: explicit settings win; otherwise the palette. A gutter color that isn't set but whose
 * background counterpart is gets a more opaque version of the background override.
 */
export function resolveColors(paletteId: string | undefined, o: ColorOverrides): ResolvedColors {
  const p = PALETTES[paletteId ?? ''] ?? PALETTES[DEFAULT_PALETTE];
  const bgFade = nonEmptyList(o.readFade);
  const bgStale = nonEmpty(o.stale);
  const out: ResolvedColors = {
    background: { readFade: bgFade ?? p.background.readFade, stale: bgStale ?? p.background.stale, categories: new Map() },
    gutter: {
      readFade: nonEmptyList(o.readFadeGutter) ?? bgFade?.map(strengthen) ?? p.gutter.readFade,
      stale: nonEmpty(o.staleGutter) ?? (bgStale && strengthen(bgStale)) ?? p.gutter.stale,
      categories: new Map(),
    },
  };
  let extra = 0;
  for (const c of o.categories) {
    const bg = nonEmpty(c.color);
    let paletteBg = p.background.categories[c.id];
    let paletteGutter = p.gutter.categories[c.id];
    if (!paletteBg && (!bg || !nonEmpty(c.gutterColor))) {
      const n = p.background.extra.length;
      paletteBg = n ? p.background.extra[extra % n] : FALLBACK;
      paletteGutter = n ? p.gutter.extra[extra % n] : FALLBACK;
      extra++;
    }
    out.background.categories.set(c.id, bg ?? paletteBg);
    out.gutter.categories.set(c.id, nonEmpty(c.gutterColor) ?? (bg && strengthen(bg)) ?? paletteGutter);
  }
  return out;
}
