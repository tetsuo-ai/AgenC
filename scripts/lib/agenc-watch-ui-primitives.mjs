/**
 * UI rendering primitives for the watch TUI: color palette, panels, badges,
 * layout helpers.
 *
 * Pure functions — no watch state or side-effect dependencies.
 */

import {
  fitAnsi,
  padAnsi,
  sanitizeInlineText,
  sanitizeLargeText,
  truncate,
  visibleLength,
  wrapBlock,
} from "./agenc-watch-text-utils.mjs";

/** Shared color palette used throughout the watch TUI. */
export const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  border: "\x1b[38;5;54m",
  borderStrong: "\x1b[38;5;99m",
  ink: "\x1b[38;5;225m",
  softInk: "\x1b[38;5;189m",
  slate: "\x1b[38;5;141m",
  fog: "\x1b[38;5;97m",
  cyan: "\x1b[38;5;117m",
  teal: "\x1b[38;5;111m",
  blue: "\x1b[38;5;39m",
  green: "\x1b[38;5;50m",
  lime: "\x1b[38;5;87m",
  yellow: "\x1b[38;5;221m",
  amber: "\x1b[38;5;213m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  panelBg: "\x1b[49m",
  panelAltBg: "\x1b[48;5;233m",
  panelHiBg: "\x1b[48;5;234m",
};

/** Tone-to-fg/bg mapping. */
export const toneTheme = {
  ink: { fg: color.ink, bg: "\x1b[49m" },
  slate: { fg: color.slate, bg: "\x1b[49m" },
  cyan: { fg: color.cyan, bg: "\x1b[49m" },
  teal: { fg: color.teal, bg: "\x1b[49m" },
  blue: { fg: color.blue, bg: "\x1b[49m" },
  green: { fg: color.green, bg: "\x1b[49m" },
  lime: { fg: color.lime, bg: "\x1b[49m" },
  yellow: { fg: color.yellow, bg: "\x1b[49m" },
  amber: { fg: color.amber, bg: "\x1b[49m" },
  magenta: { fg: color.magenta, bg: "\x1b[49m" },
  red: { fg: color.red, bg: "\x1b[49m" },
};

export function toneColor(tone) {
  return color[tone] ?? color.ink;
}

export function toneSpec(tone) {
  return toneTheme[tone] ?? toneTheme.slate;
}

export function badge(label, tone = "ink") {
  const spec = toneSpec(tone);
  return `${spec.fg}${color.bold}${label}${color.reset}${color.borderStrong}::${color.reset}`;
}

export function chip(label, value, tone = "ink") {
  return `${badge(label, tone)} ${toneColor(tone)}${color.bold}${truncate(String(value), 32)}${color.reset}`;
}

export function stateTone(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (/(error|failed|stopped|cancelled|blocked)/.test(normalized)) return "red";
  if (/(live|running|ready|completed|ok)/.test(normalized)) return "cyan";
  if (/idle/.test(normalized)) return "magenta";
  if (/(typing|thinking|queued|starting|connecting|reconnecting|pause|pending|refresh)/.test(normalized)) return "amber";
  if (/(generating|active|stream)/.test(normalized)) return "magenta";
  return "slate";
}

export function onSurface(text, bg) {
  return `${bg}${String(text).replace(/\x1b\[0m/g, `${color.reset}${bg}`)}${color.reset}`;
}

export function paintSurface(text, width, bg) {
  return onSurface(padAnsi(text, width), bg);
}

export function flexBetween(left, right, width) {
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 1 > width) {
    return fitAnsi(`${left} ${right}`, width);
  }
  return `${left}${" ".repeat(Math.max(1, width - leftLen - rightLen))}${right}`;
}

export function blankRow(width) {
  return " ".repeat(width);
}

export function panelTop(width, tone = "slate") {
  const inner = width - 2;
  const accent = Math.min(10, Math.max(3, Math.floor(inner * 0.14)));
  return `${color.border}\u250c${toneColor(tone)}${"\u2500".repeat(accent)}${color.borderStrong}${"\u2500".repeat(Math.max(0, inner - accent))}${color.reset}${color.border}\u2510${color.reset}`;
}

export function panelBottom(width) {
  return `${color.border}\u2514${color.borderStrong}${"\u2500".repeat(Math.max(0, width - 2))}${color.reset}${color.border}\u2518${color.reset}`;
}

export function panelRow(text, width, bg = color.panelBg) {
  const inner = width - 2;
  return `${color.border}\u2502${color.reset}${paintSurface(text, inner, bg)}${color.border}\u2502${color.reset}`;
}

export function renderPanel({ title, subtitle = null, tone = "slate", width, bg = color.panelBg, lines = [] }) {
  const inner = width - 2;
  const titleLine = subtitle
    ? flexBetween(
      `${toneColor(tone)}${color.bold}${title}${color.reset}`,
      `${color.fog}${subtitle}${color.reset}`,
      inner,
    )
    : `${toneColor(tone)}${color.bold}${title}${color.reset}`;
  const normalizedLines = lines.map((entry) => (
    typeof entry === "string" ? { text: entry, bg } : { text: entry?.text ?? "", bg: entry?.bg ?? bg }
  ));
  return [
    panelTop(width, tone),
    panelRow(titleLine, width, bg),
    ...normalizedLines.map((line) => panelRow(line.text, width, line.bg)),
    panelBottom(width),
  ];
}

export function row(text = "", bg = color.panelBg) {
  return { text, bg };
}

export function wrapAndLimit(text, width, maxLines = 2) {
  const lines = wrapBlock(sanitizeLargeText(String(text ?? "")), width);
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines), `+${lines.length - maxLines} more`];
}

export function formatMetric(label, value, width, tone = "slate") {
  return flexBetween(
    `${color.fog}${label.toUpperCase()}${color.reset}`,
    `${toneColor(tone)}${color.bold}${truncate(sanitizeInlineText(String(value ?? "n/a")), 34)}${color.reset}`,
    width,
  );
}

export function joinColumns(leftLines, rightLines, leftWidth, rightWidth, gap = 2) {
  const totalRows = Math.max(leftLines.length, rightLines.length);
  const gapSpacer = " ".repeat(gap);
  const lines = [];
  for (let index = 0; index < totalRows; index += 1) {
    const left = leftLines[index] ? padAnsi(leftLines[index], leftWidth) : blankRow(leftWidth);
    const right = rightLines[index] ? padAnsi(rightLines[index], rightWidth) : blankRow(rightWidth);
    lines.push(`${left}${gapSpacer}${right}`);
  }
  return lines;
}
