import { buildSourceMetadata } from "./agenc-watch-tool-presentation-core.mjs";
import { createWatchToolPresentationEditorDescriptors } from "./agenc-watch-tool-presentation-editor.mjs";
import {
  compactBodyLines,
  joinDescriptorBody,
} from "./agenc-watch-tool-presentation-utils.mjs";

export function createWatchToolPresentationCopyBuilder(dependencies = {}) {
  const {
    sanitizeInlineText,
    sanitizeDisplayText,
    truncate,
    buildToolSummary,
    maxEventBodyLines = 5,
  } = dependencies;

  const {
    describeDesktopTextEditorResult,
    describeDesktopTextEditorStart,
  } = createWatchToolPresentationEditorDescriptors({ truncate });

  function describeToolStart(data) {
    switch (data.kind) {
      case "delegate-start":
        return {
          title: `Delegate ${truncate(data.objective || "child task", 110)}`,
          body: joinDescriptorBody(
            [
              data.tools.length > 0 ? `tools: ${data.tools.join(", ")}` : null,
              data.workingDirectory ? `cwd: ${data.workingDirectory}` : null,
              data.acceptanceCriteria.length > 0
                ? `acceptance: ${truncate(data.acceptanceCriteria.join(" | "), 180)}`
                : null,
            ],
            data.objective || "(delegated child task)",
          ),
          tone: "magenta",
        };
      case "file-write-start":
        return {
          title: `${data.action === "append" ? "Append" : "Edit"} ${data.filePathDisplay || "file"}`,
          body: joinDescriptorBody(
            [data.filePathDisplay ? `path: ${data.filePathDisplay}` : null, "", data.content],
            data.filePathDisplay || "(pending file write)",
          ),
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
          body: joinDescriptorBody(
            [
              data.status ? `status: ${data.status}` : null,
              typeof data.toolCalls === "number" ? `tool calls: ${data.toolCalls}` : null,
              "",
              data.errorText ?? data.outputText ?? data.errorPreview ?? data.outputPreview,
            ],
            "(delegation finished)",
          ),
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
          body: joinDescriptorBody(
            [data.filePathDisplay ? `path: ${data.filePathDisplay}` : null, data.sizeText, "", data.content],
            data.filePathDisplay || "(file read)",
          ),
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
              : compactBodyLines(data.prettyResult, {
                sanitizeDisplayText,
                sanitizeInlineText,
                truncate,
                maxLines: maxEventBodyLines,
              }).join("\n"),
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
