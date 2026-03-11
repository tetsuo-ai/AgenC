export const SHELL_COMMAND_SEPARATORS = new Set([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "(",
  ")",
  "`",
]);

export const SHELL_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  "<",
  "<<",
  "<>",
  ">&",
  "<&",
  ">|",
]);

const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./+-]+$/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const DIRECT_MODE_REDIRECT_TOKEN_RE = /^\d*(?:>|>>|<|<<|<>|>&|<&|>\|)$/;

export interface ParsedDirectCommandLine {
  readonly command: string;
  readonly args: string[];
}

/**
 * Tokenize a shell command string while preserving shell operators.
 * Quoted segments are preserved as single tokens without quote characters.
 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  const pushOperator = (operator: string) => {
    pushCurrent();
    tokens.push(operator);
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i];
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\n") {
      pushOperator(";");
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (
      ch === "|" ||
      ch === "&" ||
      ch === ";" ||
      ch === "<" ||
      ch === ">" ||
      ch === "(" ||
      ch === ")" ||
      ch === "`"
    ) {
      const next = command[i + 1] ?? "";
      const pair = ch + next;
      if (
        pair === "||" ||
        pair === "&&" ||
        pair === ">>" ||
        pair === "<<" ||
        pair === ">&" ||
        pair === "<&" ||
        pair === ">|"
      ) {
        pushOperator(pair);
        i += 1;
        continue;
      }
      pushOperator(ch);
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  pushCurrent();
  return tokens;
}

export function collectDirectModeShellControlTokens(
  tokens: readonly string[],
): string[] {
  const detected = new Set<string>();
  for (const token of tokens) {
    if (
      SHELL_COMMAND_SEPARATORS.has(token) ||
      SHELL_REDIRECT_OPERATORS.has(token) ||
      DIRECT_MODE_REDIRECT_TOKEN_RE.test(token) ||
      token === "$"
    ) {
      detected.add(token);
    }
  }
  return [...detected];
}

export function containsDirectModeShellControlTokens(
  tokens: readonly string[],
): boolean {
  return collectDirectModeShellControlTokens(tokens).length > 0;
}

/**
 * Parse a command line into direct-exec `{ command, args }` form.
 * Returns `undefined` for shell-style commands or ambiguous inputs.
 */
export function parseDirectCommandLine(
  commandLine: string,
): ParsedDirectCommandLine | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return undefined;
  }

  const tokens = tokenizeShellCommand(trimmed);
  if (tokens.length === 0) {
    return undefined;
  }

  if (containsDirectModeShellControlTokens(tokens)) {
    return undefined;
  }

  const [command, ...args] = tokens;
  if (!command || ENV_ASSIGNMENT_RE.test(command) || !SINGLE_EXECUTABLE_RE.test(command)) {
    return undefined;
  }

  return { command, args };
}
