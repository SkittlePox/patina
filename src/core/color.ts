export type RGBA = [number, number, number, number];

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(...) and rgba(...). Returns undefined for anything else. */
export function parseColor(input: string): RGBA | undefined {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (fn) {
    let a = 1;
    if (fn[4] !== undefined) a = fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return [+fn[1], +fn[2], +fn[3], a];
  }
  return undefined;
}

export function formatColor([r, g, b, a]: RGBA): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000})`;
}

/** Interpolate along evenly spaced color stops; `f` in [0, 1]. */
export function interpolateStops(stops: RGBA[], f: number): RGBA {
  if (stops.length === 0) return [128, 128, 128, 0.15];
  if (stops.length === 1) return stops[0];
  const x = Math.min(1, Math.max(0, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const t = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [0, 1, 2, 3].map((k) => a[k] + (b[k] - a[k]) * t) as RGBA;
}

export function withMinAlpha([r, g, b, a]: RGBA, min: number): RGBA {
  return [r, g, b, Math.max(a, min)];
}
