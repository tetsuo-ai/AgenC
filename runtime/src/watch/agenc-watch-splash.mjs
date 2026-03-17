const SPLASH_ART_LARGE = [
  { tone: "slate", text: "                  ░▒▓████████▓▒░                  " },
  { tone: "magenta", text: "               ░▓██████████████▓░               " },
  { tone: "magenta", text: "              ▒██████████████████▒              " },
  { tone: "softInk", text: "             ▓████████████████████▓             " },
  { tone: "softInk", text: "             ███████████████████▓██             " },
  { tone: "ink", text: "             █████████████████▓   ░             " },
  { tone: "ink", text: "             ████████████████▒                  " },
  { tone: "ink", text: "             ████████████████                   " },
];

const SPLASH_ART_SMALL = [
  { tone: "magenta", text: "          ░▓██████▓░          " },
  { tone: "softInk", text: "        ░████████████░        " },
  { tone: "ink", text: "        ████████████▒         " },
  { tone: "ink", text: "        ███████████           " },
];

function visibleLength(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function centerAnsi(text, width, fitAnsi) {
  const fitted = fitAnsi(text, width);
  const remaining = Math.max(0, width - visibleLength(fitted));
  const leftPad = Math.floor(remaining / 2);
  const rightPad = remaining - leftPad;
  return `${" ".repeat(leftPad)}${fitted}${" ".repeat(rightPad)}`;
}

export function createWatchSplashRenderer(dependencies = {}) {
  const {
    watchState,
    transportState,
    events,
    introDismissKinds,
    currentInputValue,
    launchedAtMs,
    startupSplashMinMs,
    shouldShowWatchSplash,
    nowMs = () => Date.now(),
    toneColor,
    fitAnsi,
    truncate,
    sanitizeInlineText,
    color,
  } = dependencies;

  function splashProgressLevel() {
    if (watchState.bootstrapReady && transportState.connectionState === "live") return 1;
    if (watchState.sessionId) return 0.8;
    if (transportState.isOpen) return 0.58;
    if (transportState.connectionState === "reconnecting") return 0.34;
    return 0.2;
  }

  function shouldShowSplash() {
    return shouldShowWatchSplash({
      introDismissed: watchState.introDismissed,
      currentObjective: watchState.currentObjective,
      inputValue: currentInputValue(),
      bootstrapReady: watchState.bootstrapReady,
      launchedAtMs,
      startupSplashMinMs,
      eventKinds: events.map((event) => event.kind).filter((kind) => introDismissKinds.has(kind)),
      nowMs: nowMs(),
    });
  }

  function splashArtLines(width) {
    const source = width >= 96 ? SPLASH_ART_LARGE : SPLASH_ART_SMALL;
    return source.map((entry) =>
      centerAnsi(`${toneColor(entry.tone)}${entry.text}${color.reset}`, width, fitAnsi),
    );
  }

  function splashProgressBar(width, level, tone = "magenta") {
    const clamped = Math.max(0, Math.min(1, Number(level) || 0));
    const fill = Math.max(0, Math.min(width, Math.round(clamped * width)));
    return `${toneColor(tone)}${"█".repeat(fill)}${color.fog}${"░".repeat(Math.max(0, width - fill))}${color.reset}`;
  }

  function renderCompactSplash(width, height) {
    const progress = splashProgressLevel();
    const tone =
      watchState.bootstrapReady && transportState.connectionState === "live"
        ? "teal"
        : "magenta";
    const statusLabel = watchState.bootstrapReady
      ? "READY"
      : transportState.connectionState === "reconnecting"
        ? "RECONNECTING"
        : "CONNECTING";
    const progressWidth = Math.max(14, Math.min(22, width - 22));
    const hint = watchState.bootstrapReady
      ? "session restored, console ready"
      : watchState.transientStatus;
    const content = [
      centerAnsi(
        `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.softInk}https://agenc.tech${color.reset}`,
        width,
        fitAnsi,
      ),
      "",
      centerAnsi(`${toneColor(tone)}${color.bold}${statusLabel}${color.reset}`, width, fitAnsi),
      centerAnsi(
        `${color.softInk}[${color.reset}${splashProgressBar(progressWidth, progress, tone)}${color.softInk}]${color.reset}`,
        width,
        fitAnsi,
      ),
      centerAnsi(
        `${color.fog}${truncate(sanitizeInlineText(hint), Math.max(24, width - 6))}${color.reset}`,
        width,
        fitAnsi,
      ),
    ];
    const visibleContent = content.slice(0, Math.max(4, height));
    const topPadding = Math.max(0, Math.floor((height - visibleContent.length) / 2));
    return [
      ...Array.from({ length: topPadding }, () => ""),
      ...visibleContent,
    ];
  }

  function renderSplash(width, height) {
    const progress = splashProgressLevel();
    const tone =
      watchState.bootstrapReady && transportState.connectionState === "live"
        ? "teal"
        : "magenta";
    const statusLabel = watchState.bootstrapReady
      ? "READY"
      : transportState.connectionState === "reconnecting"
        ? "RECONNECTING"
        : "CONNECTING TO AGENC";
    const hint = watchState.bootstrapReady
      ? "type a prompt to begin"
      : "initializing agent runtime...";
    const progressWidth = Math.max(18, Math.min(30, width - 28));
    const progressLine = centerAnsi(
      `${color.softInk}[${color.reset}${splashProgressBar(progressWidth, progress, tone)}${color.softInk}] ${String(Math.round(progress * 100)).padStart(3, " ")}%${color.reset}`,
      width,
      fitAnsi,
    );
    const content = [
      centerAnsi(
        `${color.magenta}${color.bold}A G E N / C${color.reset} ${color.softInk}https://agenc.tech${color.reset}`,
        width,
        fitAnsi,
      ),
      centerAnsi(
        `${color.fog}clean signal // low clutter // live autonomy${color.reset}`,
        width,
        fitAnsi,
      ),
      "",
      ...splashArtLines(width),
      "",
      centerAnsi(`${toneColor(tone)}${color.bold}${statusLabel}${color.reset}`, width, fitAnsi),
      progressLine,
      centerAnsi(`${color.fog}${hint}${color.reset}`, width, fitAnsi),
    ];
    const topPadding = Math.max(0, Math.floor((height - content.length) / 2));
    return [
      ...Array.from({ length: topPadding }, () => ""),
      ...content,
    ];
  }

  return {
    renderCompactSplash,
    renderSplash,
    shouldShowSplash,
  };
}
