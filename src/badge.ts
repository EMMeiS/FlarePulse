import type { MonitorStatus } from "./db";

/** Badge geometry. Shields' proportions, because that is what a README expects. */
const HEIGHT = 20;
const FONT_SIZE = 11;
const PADDING = 10;

/**
 * Note: character count times a constant, not real text metrics — a Worker
 * has no font tables. Wide enough for Verdana at 11px; swap in a per-character
 * width table if a proportional name ever looks cramped.
 */
const CHAR_WIDTH = 6.5;

const COLOURS: Record<MonitorStatus, string> = {
  up: "#2ea043",
  down: "#d1242f",
  pending: "#8b949e",
};

const LABEL_BG = "#555555";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textWidth(text: string): number {
  return Math.round(text.length * CHAR_WIDTH) + PADDING * 2;
}

/**
 * One self-contained SVG: no external font, no CSS, no request of its own, so it
 * renders the same in a README, a Notion page and an email client.
 *
 * The clip-path id is fixed rather than generated — a badge is embedded as an
 * `<img>`, which is its own document, so two badges on a page cannot collide.
 */
export function badgeSvg(label: string, value: string, status: MonitorStatus): string {
  const labelWidth = textWidth(label);
  const valueWidth = textWidth(value);
  const width = labelWidth + valueWidth;
  const title = escapeXml(`${label}: ${value} (${status})`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${title}">
  <title>${title}</title>
  <clipPath id="flarepulse-badge"><rect width="${width}" height="${HEIGHT}" rx="3"/></clipPath>
  <g clip-path="url(#flarepulse-badge)">
    <rect width="${labelWidth}" height="${HEIGHT}" fill="${LABEL_BG}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${HEIGHT}" fill="${COLOURS[status]}"/>
  </g>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="${FONT_SIZE}" text-anchor="middle">
    <text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>
`;
}
