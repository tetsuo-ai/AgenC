export function buildAltScreenEnterSequence({ enableMouseTracking = true } = {}) {
  if (!enableMouseTracking) {
    return "\x1b[?1049h\x1b[?25h";
  }
  return "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[?25h";
}

export function buildAltScreenLeaveSequence({ enableMouseTracking = true } = {}) {
  if (!enableMouseTracking) {
    return "\x1b[?25h\x1b[?1049l";
  }
  return "\x1b[?25h\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l";
}

export function supportsTerminalHyperlinks({
  stream = process.stdout,
  env = process.env,
} = {}) {
  if (env?.AGENC_WATCH_ENABLE_HYPERLINKS === "0") {
    return false;
  }
  if (env?.AGENC_WATCH_ENABLE_HYPERLINKS === "1") {
    return true;
  }
  if (!stream?.isTTY) {
    return false;
  }
  const term = String(env?.TERM ?? "").toLowerCase();
  if (term === "dumb") {
    return false;
  }
  const termProgram = String(env?.TERM_PROGRAM ?? "");
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "vscode"
  ) {
    return true;
  }
  if (typeof env?.WT_SESSION === "string" && env.WT_SESSION.length > 0) {
    return true;
  }
  if (typeof env?.KONSOLE_VERSION === "string" && env.KONSOLE_VERSION.length > 0) {
    return true;
  }
  const vteVersion = Number(env?.VTE_VERSION);
  if (Number.isFinite(vteVersion) && vteVersion >= 5000) {
    return true;
  }
  return /kitty|wezterm|ghostty|foot|alacritty|xterm-kitty/i.test(term);
}

export function buildTerminalHyperlinkSequence(text, href) {
  const content = String(text ?? "");
  const destination = String(href ?? "").trim();
  if (!content || !destination) {
    return content;
  }
  return `\x1b]8;;${destination}\x07${content}\x1b]8;;\x07`;
}

export function parseMouseWheelSequence(input, index = 0) {
  const source = String(input ?? "").slice(index);
  const mouseMatch = source.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!mouseMatch) {
    return null;
  }
  const buttonCode = Number(mouseMatch[1]);
  if (!Number.isFinite(buttonCode) || (buttonCode & 64) === 0) {
    return {
      length: mouseMatch[0].length,
      delta: 0,
      isWheel: false,
    };
  }
  return {
    length: mouseMatch[0].length,
    delta: (buttonCode & 1) === 1 ? -3 : 3,
    isWheel: true,
  };
}
