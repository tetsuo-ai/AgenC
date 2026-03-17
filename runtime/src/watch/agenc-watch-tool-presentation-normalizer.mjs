import path from "node:path";

export const DEFAULT_LOW_SIGNAL_SHELL_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc",
]);

function shellCommandTokens(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }
  const tokens = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function stripShellTokenQuotes(token) {
  if (typeof token !== "string" || token.length < 2) {
    return token;
  }
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === `"` || first === "'" || first === "`") && last === first) {
    return token.slice(1, -1);
  }
  return token;
}

export function createWatchToolPresentationNormalizer(dependencies = {}) {
  const {
    sanitizeInlineText,
    sanitizeLargeText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    lowSignalShellCommands = DEFAULT_LOW_SIGNAL_SHELL_COMMANDS,
  } = dependencies;

  function formatBytes(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return null;
    }
    if (numeric < 1024) return `${numeric} B`;
    if (numeric < 1024 * 1024) {
      return `${(numeric / 1024).toFixed(numeric >= 10 * 1024 ? 0 : 1)} KB`;
    }
    return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
  }

  function compactPathForDisplay(value, maxChars = 76) {
    const text = sanitizeInlineText(String(value ?? ""));
    if (text.length <= maxChars) {
      return text;
    }
    const parts = text.split("/");
    if (parts.length <= 3) {
      return truncate(text, maxChars);
    }
    return truncate(
      `${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}`,
      maxChars,
    );
  }

  function firstMeaningfulLine(value) {
    if (typeof value !== "string") return null;
    const line = sanitizeLargeText(value)
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean);
    return line ? truncate(line, 160) : null;
  }

  function formatShellCommand(command, args) {
    const base = typeof command === "string" ? command.trim() : "";
    if (!base) return null;
    const argv = Array.isArray(args)
      ? args.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    if (argv.length === 0) {
      return truncate(base, 180);
    }
    return truncate(
      [base, ...argv.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))].join(" "),
      180,
    );
  }

  function editorCommandName(payload) {
    return sanitizeInlineText(payload?.command ?? payload?.action ?? "").toLowerCase();
  }

  function editorRawTargetPath(payload) {
    const value = payload?.path ?? payload?.filePath;
    return typeof value === "string" && value.trim().length > 0
      ? sanitizeInlineText(value)
      : null;
  }

  function editorTargetPath(payload) {
    return compactPathForDisplay(editorRawTargetPath(payload));
  }

  function editorBodyText(payload) {
    const candidates = [
      payload?.file_text,
      payload?.text,
      payload?.new_str,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate;
      }
    }
    return null;
  }

  function normalizeRange(value) {
    if (Array.isArray(value) && value.length === 2) {
      return {
        startLine: Number(value[0]),
        endLine: Number(value[1]),
      };
    }
    return null;
  }

  function normalizePayload(args) {
    return args && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  }

  function firstShellCommandToken(command) {
    const tokens = shellCommandTokens(command);
    for (const token of tokens) {
      const normalized = stripShellTokenQuotes(token);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) {
        continue;
      }
      return normalized;
    }
    return null;
  }

  function shellCommandBasename(payload) {
    const directCommand =
      typeof payload?.command === "string" && payload.command.trim().length > 0
        ? payload.command.trim()
        : "";
    const basenameSource =
      Array.isArray(payload?.args) && directCommand && !/\s/.test(directCommand)
        ? directCommand
        : firstShellCommandToken(directCommand);
    return basenameSource ? path.basename(basenameSource) : null;
  }

  function isLowSignalShellCommand(payload) {
    const basename = shellCommandBasename(payload);
    return Boolean(basename && lowSignalShellCommands.has(basename));
  }

  function isDesktopTextEditorReadCommand(payload) {
    return editorCommandName(payload) === "view";
  }

  function shouldSuppressToolTranscript(toolName, args, { isError = false } = {}) {
    if (isError) {
      return false;
    }
    switch (toolName) {
      case "system.readFile":
      case "system.listDir":
        return true;
      case "system.bash":
      case "desktop.bash":
        return isLowSignalShellCommand(args);
      case "desktop.text_editor":
        return isDesktopTextEditorReadCommand(args);
      default:
        return false;
    }
  }

  function shouldSuppressToolActivity(toolName, args, options = {}) {
    return shouldSuppressToolTranscript(toolName, args, options);
  }

  function normalizeDesktopTextEditorStart(payload) {
    return {
      kind: "desktop-editor-start",
      command: editorCommandName(payload),
      filePathDisplay: editorTargetPath(payload),
      filePathRaw: editorRawTargetPath(payload),
      sourceText: editorBodyText(payload),
      oldText: typeof payload?.old_str === "string" ? payload.old_str : null,
      insertLine: Number.isFinite(Number(payload?.insert_line))
        ? Number(payload.insert_line)
        : null,
      viewRange: normalizeRange(payload?.view_range),
    };
  }

  function normalizeDesktopTextEditorResult(payload, resultObject, isError) {
    return {
      kind: "desktop-editor-result",
      isError,
      command: editorCommandName(payload),
      filePathDisplay: editorTargetPath(payload),
      filePathRaw: editorRawTargetPath(payload),
      sourceText: editorBodyText(payload),
      oldText: typeof payload?.old_str === "string" ? payload.old_str : null,
      insertLine: Number.isFinite(Number(payload?.insert_line))
        ? Number(payload.insert_line)
        : null,
      viewRange: normalizeRange(payload?.view_range),
      outputText:
        typeof resultObject?.output === "string" && resultObject.output.trim().length > 0
          ? resultObject.output
          : null,
    };
  }

  function normalizeToolStart(toolName, args) {
    const payload = normalizePayload(args);
    switch (toolName) {
      case "execute_with_agent":
        return {
          kind: "delegate-start",
          objective: sanitizeInlineText(
            payload.objective ?? payload.task ?? payload.inputContract ?? "",
          ),
          tools: Array.isArray(payload.tools)
            ? payload.tools.filter((value) => typeof value === "string")
            : [],
          workingDirectory:
            typeof payload.workingDirectory === "string"
              ? compactPathForDisplay(payload.workingDirectory)
              : null,
          acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
            ? payload.acceptanceCriteria.filter((value) => typeof value === "string")
            : [],
        };
      case "system.writeFile":
      case "system.appendFile":
        return {
          kind: "file-write-start",
          action: toolName === "system.appendFile" ? "append" : "write",
          filePathDisplay: compactPathForDisplay(payload.path),
          filePathRaw:
            typeof payload?.path === "string" && payload.path.trim().length > 0
              ? sanitizeInlineText(payload.path)
              : null,
          content:
            typeof payload.content === "string" && payload.content.trim().length > 0
              ? payload.content
              : null,
        };
      case "system.readFile":
        return {
          kind: "file-read-start",
          filePathDisplay: compactPathForDisplay(payload.path),
          filePathRaw:
            typeof payload?.path === "string" && payload.path.trim().length > 0
              ? sanitizeInlineText(payload.path)
              : null,
        };
      case "system.listDir":
        return {
          kind: "list-dir-start",
          dirPathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
        };
      case "system.bash":
        return {
          kind: "shell-start",
          commandText: formatShellCommand(payload.command, payload.args),
          cwdDisplay: compactPathForDisplay(payload.cwd),
        };
      case "desktop.text_editor":
        return normalizeDesktopTextEditorStart(payload);
      default:
        return {
          kind: "generic-start",
          toolName,
          payloadText: stable(payload),
        };
    }
  }

  function normalizeToolResult(toolName, args, isError, result) {
    const payload = normalizePayload(args);
    const parsed = tryParseJson(typeof result === "string" ? result : stable(result)) ?? {};
    const resultObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};

    switch (toolName) {
      case "execute_with_agent":
        return {
          kind: "delegate-result",
          isError,
          childToken: sanitizeInlineText(String(resultObject.subagentSessionId ?? "")).slice(-8),
          status: sanitizeInlineText(resultObject.status ?? ""),
          toolCalls: typeof resultObject.toolCalls === "number" ? resultObject.toolCalls : null,
          outputText:
            typeof resultObject.output === "string" && resultObject.output.trim().length > 0
              ? resultObject.output
              : null,
          errorText:
            typeof resultObject.error === "string" && resultObject.error.trim().length > 0
              ? resultObject.error
              : null,
          outputPreview: firstMeaningfulLine(
            typeof resultObject.output === "string" ? resultObject.output : "",
          ),
          errorPreview: firstMeaningfulLine(
            typeof resultObject.error === "string" ? resultObject.error : "",
          ),
        };
      case "system.writeFile":
      case "system.appendFile": {
        const filePathValue = resultObject.path ?? payload.path;
        return {
          kind: "file-write-result",
          isError,
          action: toolName === "system.appendFile" ? "append" : "write",
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw:
            typeof filePathValue === "string" && String(filePathValue).trim().length > 0
              ? sanitizeInlineText(String(filePathValue))
              : null,
          bytesWrittenText: formatBytes(resultObject.bytesWritten),
          content:
            typeof payload?.content === "string" ? payload.content : null,
        };
      }
      case "system.readFile": {
        const filePathValue = resultObject.path ?? payload.path;
        return {
          kind: "file-read-result",
          isError,
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw:
            typeof filePathValue === "string" && String(filePathValue).trim().length > 0
              ? sanitizeInlineText(String(filePathValue))
              : null,
          sizeText: formatBytes(resultObject.size),
          content:
            typeof resultObject.content === "string" && resultObject.content.trim().length > 0
              ? resultObject.content
              : null,
        };
      }
      case "system.listDir":
        return {
          kind: "list-dir-result",
          isError,
          dirPathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
          entries: Array.isArray(resultObject.entries)
            ? resultObject.entries
              .slice(0, 6)
              .map((entry) => (typeof entry?.name === "string" ? entry.name : null))
              .filter(Boolean)
            : [],
        };
      case "desktop.text_editor":
        return normalizeDesktopTextEditorResult(payload, resultObject, isError);
      case "system.bash":
        return {
          kind: "shell-result",
          isError,
          commandText: formatShellCommand(payload.command, payload.args),
          cwdDisplay: compactPathForDisplay(payload.cwd),
          exitCode: resultObject.exitCode,
          stdoutPreview: firstMeaningfulLine(resultObject.stdout),
          stderrPreview: firstMeaningfulLine(resultObject.stderr),
        };
      default:
        return {
          kind: "generic-result",
          toolName,
          isError,
          summaryEntries: parseStructuredJson(result),
          prettyResult: tryPrettyJson(result),
        };
    }
  }

  return {
    compactPathForDisplay,
    formatShellCommand,
    normalizeToolResult,
    normalizeToolStart,
    shouldSuppressToolActivity,
    shouldSuppressToolTranscript,
  };
}
