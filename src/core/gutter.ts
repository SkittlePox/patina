import { parseColor } from './color';

/**
 * SVG for a gutter bar: a vertical strip at the right edge of the glyph margin (next to the line numbers).
 * Stretched to the full cell with `preserveAspectRatio="none"`, so consecutive lines join into one bar.
 */
export function gutterBarSvg(color: string): string {
  const rgba = parseColor(color);
  let fill: string;
  if (rgba) {
    const hex = rgba.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
    fill = `fill="#${hex}" fill-opacity="${Math.round(rgba[3] * 1000) / 1000}"`;
  } else {
    fill = `fill="${color.replace(/[&<>"]/g, '')}"`;
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none">' +
    `<rect x="11" y="0" width="5" height="16" ${fill}/></svg>`
  );
}
