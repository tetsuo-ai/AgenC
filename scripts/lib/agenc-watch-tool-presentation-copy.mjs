export function createWatchToolPresentationCopyBuilder(dependencies = {}) {
  const {
    sanitizeInlineText,
    sanitizeDisplayText,
    truncate,
    buildToolSummary,
    maxEventBodyLines = 5,
  } = dependencies;

  function compactBodyLines(value, maxLines = maxEventBodyLines) {
    const lines = sanitizeDisplayText(value)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^[\[\]{}(),]+$/.test(line));
    if (lines.length === 0) {
      const fallback = sanitizeInlineText(String(value ?? ""));
      return fallback ? [fallback] : [];
    }
    return lines.slice(0, maxLines).map((line) => truncate(line, 220));
  }

  function buildSourceMetadata({
    filePath = null,
    fileRange = null,
    mutationKind = null,
    mutationBeforeText = undefined,
    mutationAfterText = undefined,
  } = {}) {
    const metadata = {};
    if (filePath) {
      metadata.filePath = filePath;
    }
    if (fileRange && typeof fileRange === "object") {
      metadata.fileRange = fileRange;
    }
    if (mutationKind) {
      metadata.mutationKind = mutationKind;
    }
    if (typeof mutationBeforeText === "string") {
      metadata.mutationBeforeText = mutationBeforeText;
    }
    if (typeof mutationAfterText === "string") {
      metadata.mutationAfterText = mutationAfterText;
    }
    return metadata;
  }

  function describeDesktopTextEditorStart(data) {
    const filePath = data.filePathDisplay;
    const rawFilePath = data.filePathRaw;
    const sourceText = data.sourceText;
    switch (data.command) {
      case "create":
        return {
          title: `Create ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(pending file create)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: "create",
            mutationAfterText: sourceText,
          }),
        };
      case "str_replace":
        return {
          title: `Edit ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            typeof data.oldText === "string" && data.oldText.trim().length > 0
              ? `replace: ${truncate(data.oldText, 96)}`
              : null,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(pending text replace)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: "replace",
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: sourceText,
          }),
        };
      case "insert":
        return {
          title: `Insert ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            Number.isFinite(data.insertLine)
              ? `after line: ${data.insertLine}`
              : null,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(pending text insert)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            fileRange: Number.isFinite(data.insertLine)
              ? { afterLine: data.insertLine }
              : null,
            mutationKind: "insert",
            mutationAfterText: sourceText,
          }),
        };
      case "view":
        return {
          title: `Read ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            data.viewRange ? `range: ${data.viewRange.startLine}-${data.viewRange.endLine}` : null,
          ].filter(Boolean).join("\n") || filePath || "(pending read)",
          tone: "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            fileRange: data.viewRange,
          }),
        };
      case "undo_edit":
        return {
          title: `Undo ${filePath || "file"}`,
          body: filePath ? `path: ${filePath}` : "(pending undo)",
          tone: "yellow",
        };
      default:
        return {
          title: `Edit ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(pending text editor command)",
          tone: "yellow",
          previewMode: sourceText ? "source-write" : undefined,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: sourceText ? "write" : null,
            mutationAfterText: sourceText,
          }),
        };
    }
  }

  function describeDesktopTextEditorResult(data) {
    const filePath = data.filePathDisplay;
    const rawFilePath = data.filePathRaw;
    const sourceText = data.sourceText;
    const outputText = data.outputText;
    switch (data.command) {
      case "create":
      case "str_replace":
      case "insert":
        return {
          title: `${data.command === "create" ? "Created" : "Edited"} ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            sourceText ? null : outputText,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(file updated)",
          tone: data.isError ? "red" : "green",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind:
              data.command === "create"
                ? "create"
                : data.command === "insert"
                  ? "insert"
                  : "replace",
            fileRange:
              data.command === "insert" && Number.isFinite(data.insertLine)
                ? { afterLine: data.insertLine }
                : null,
            mutationBeforeText:
              data.command === "str_replace" && typeof data.oldText === "string"
                ? data.oldText
                : undefined,
            mutationAfterText: sourceText,
          }),
        };
      case "view":
        return {
          title: `Read ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            "",
            outputText,
          ].filter(Boolean).join("\n") || filePath || "(file read)",
          tone: data.isError ? "red" : "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: rawFilePath,
            fileRange: data.viewRange,
          }),
        };
      case "undo_edit":
        return {
          title: `Undid ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            outputText,
          ].filter(Boolean).join("\n") || filePath || "(edit restored)",
          tone: data.isError ? "red" : "green",
        };
      default:
        return {
          title: `${data.isError ? "Editor failed" : "Editor updated"} ${filePath || "file"}`,
          body: [
            filePath ? `path: ${filePath}` : null,
            outputText,
            "",
            sourceText,
          ].filter(Boolean).join("\n") || filePath || "(editor completed)",
          tone: data.isError ? "red" : "green",
          previewMode: sourceText ? "source-write" : undefined,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: sourceText ? "write" : null,
            mutationAfterText: sourceText,
          }),
        };
    }
  }

  function describeToolStart(data) {
    switch (data.kind) {
      case "delegate-start":
        return {
          title: `Delegate ${truncate(data.objective || "child task", 110)}`,
          body: [
            data.tools.length > 0 ? `tools: ${data.tools.join(", ")}` : null,
            data.workingDirectory ? `cwd: ${data.workingDirectory}` : null,
            data.acceptanceCriteria.length > 0
              ? `acceptance: ${truncate(data.acceptanceCriteria.join(" | "), 180)}`
              : null,
          ].filter(Boolean).join("\n") || data.objective || "(delegated child task)",
          tone: "magenta",
        };
      case "file-write-start":
        return {
          title: `${data.action === "append" ? "Append" : "Edit"} ${data.filePathDisplay || "file"}`,
          body: [
            data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
            "",
            data.content,
          ].filter(Boolean).join("\n") || data.filePathDisplay || "(pending file write)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            mutationKind: data.action,
            mutationAfterText: data.content ?? undefined,
          }),
        };
      case "file-read-start":
        return {
          title: `Read ${data.filePathDisplay || "file"}`,
          body: data.filePathDisplay ? `path: ${data.filePathDisplay}` : "(pending read)",
          tone: "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      case "list-dir-start":
        return {
          title: `List ${data.dirPathDisplay || "directory"}`,
          body: data.dirPathDisplay || "(pending directory listing)",
          tone: "slate",
        };
      case "shell-start":
        return {
          title: `Run ${data.commandText || "command"}`,
          body: data.cwdDisplay ? `cwd: ${data.cwdDisplay}` : data.commandText || "(pending command)",
          tone: "yellow",
        };
      case "desktop-editor-start":
        return describeDesktopTextEditorStart(data);
      default:
        return {
          title: data.toolName,
          body: truncate(data.payloadText, 220),
          tone: "yellow",
        };
    }
  }

  function describeToolResult(data) {
    switch (data.kind) {
      case "delegate-result":
        return {
          title: `${data.isError ? "Delegation failed" : "Delegated"} ${
            data.childToken ? `child ${data.childToken}` : "child task"
          }`,
          body: [
            data.status ? `status: ${data.status}` : null,
            typeof data.toolCalls === "number" ? `tool calls: ${data.toolCalls}` : null,
            "",
            data.errorText ?? data.outputText ?? data.errorPreview ?? data.outputPreview,
          ].filter((value) => value !== null).join("\n") || "(delegation finished)",
          tone: data.isError ? "red" : "magenta",
        };
      case "file-write-result":
        return {
          title: `${data.action === "append" ? "Appended" : "Edited"} ${data.filePathDisplay || "file"}`,
          body: `${data.filePathDisplay || "file"}${data.bytesWrittenText ? ` (${data.bytesWrittenText})` : ""}`,
          tone: data.isError ? "red" : "green",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            mutationKind: data.action,
            mutationAfterText: typeof data.content === "string" ? data.content : undefined,
          }),
        };
      case "file-read-result":
        return {
          title: `Read ${data.filePathDisplay || "file"}`,
          body: [
            data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
            data.sizeText,
            "",
            data.content,
          ].filter(Boolean).join("\n") || data.filePathDisplay || "(file read)",
          tone: data.isError ? "red" : "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      case "list-dir-result":
        return {
          title: `Listed ${data.dirPathDisplay || "directory"}`,
          body:
            data.entries.length > 0
              ? data.entries.join("  ")
              : data.dirPathDisplay || "(directory listed)",
          tone: data.isError ? "red" : "slate",
        };
      case "desktop-editor-result":
        return describeDesktopTextEditorResult(data);
      case "shell-result": {
        const shellPreview = data.isError
          ? (data.stderrPreview ?? data.stdoutPreview ?? "")
          : (data.stdoutPreview ?? data.stderrPreview ?? "");
        const shellFirstLine = sanitizeInlineText(
          String(shellPreview).split("\n")[0] ?? "",
        );
        const shellBody = data.isError
          ? shellFirstLine || data.commandText || "(command failed)"
          : [
            data.exitCode !== undefined ? `exit ${data.exitCode}` : null,
            shellFirstLine,
          ].filter(Boolean).join(" · ") || data.commandText || "(command completed)";
        return {
          title: `${data.isError ? "Command failed" : "Ran"} ${data.commandText || "command"}`,
          body: shellBody,
          tone: data.isError ? "red" : "green",
        };
      }
      default: {
        const summary = buildToolSummary(data.summaryEntries);
        return {
          title: data.isError ? `${data.toolName} failed` : data.toolName,
          body:
            summary.length > 0
              ? summary.join("\n")
              : compactBodyLines(data.prettyResult, maxEventBodyLines).join("\n"),
          tone: data.isError ? "red" : "green",
        };
      }
    }
  }

  return {
    describeToolResult,
    describeToolStart,
  };
}
