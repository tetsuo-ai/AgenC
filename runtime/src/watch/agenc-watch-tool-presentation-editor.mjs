import {
  buildSourceMetadata,
  WATCH_SOURCE_MUTATION_KINDS,
  WATCH_SOURCE_PREVIEW_MODES,
} from "./agenc-watch-tool-presentation-core.mjs";
import { joinDescriptorBody } from "./agenc-watch-tool-presentation-utils.mjs";

export function createWatchToolPresentationEditorDescriptors({ truncate }) {
  function describeDesktopTextEditorStart(data) {
    const filePath = data.filePathDisplay;
    const rawFilePath = data.filePathRaw;
    const sourceText = data.sourceText;
    switch (data.command) {
      case "create":
        return {
          title: `Create ${filePath || "file"}`,
          body: joinDescriptorBody(
            [filePath ? `path: ${filePath}` : null, "", sourceText],
            filePath || "(pending file create)",
          ),
          tone: "yellow",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.write,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: WATCH_SOURCE_MUTATION_KINDS.create,
            mutationAfterText: sourceText,
          }),
        };
      case "str_replace":
        return {
          title: `Edit ${filePath || "file"}`,
          body: joinDescriptorBody(
            [
              filePath ? `path: ${filePath}` : null,
              typeof data.oldText === "string" && data.oldText.trim().length > 0
                ? `replace: ${truncate(data.oldText, 96)}`
                : null,
              "",
              sourceText,
            ],
            filePath || "(pending text replace)",
          ),
          tone: "yellow",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.write,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: WATCH_SOURCE_MUTATION_KINDS.replace,
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: sourceText,
          }),
        };
      case "insert":
        return {
          title: `Insert ${filePath || "file"}`,
          body: joinDescriptorBody(
            [
              filePath ? `path: ${filePath}` : null,
              Number.isFinite(data.insertLine)
                ? `after line: ${data.insertLine}`
                : null,
              "",
              sourceText,
            ],
            filePath || "(pending text insert)",
          ),
          tone: "yellow",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.write,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            fileRange: Number.isFinite(data.insertLine)
              ? { afterLine: data.insertLine }
              : null,
            mutationKind: WATCH_SOURCE_MUTATION_KINDS.insert,
            mutationAfterText: sourceText,
          }),
        };
      case "view":
        return {
          title: `Read ${filePath || "file"}`,
          body: joinDescriptorBody(
            [
              filePath ? `path: ${filePath}` : null,
              data.viewRange ? `range: ${data.viewRange.startLine}-${data.viewRange.endLine}` : null,
            ],
            filePath || "(pending read)",
          ),
          tone: "slate",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.read,
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
          body: joinDescriptorBody(
            [filePath ? `path: ${filePath}` : null, "", sourceText],
            filePath || "(pending text editor command)",
          ),
          tone: "yellow",
          previewMode: sourceText ? WATCH_SOURCE_PREVIEW_MODES.write : undefined,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: sourceText ? WATCH_SOURCE_MUTATION_KINDS.write : null,
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
          body: joinDescriptorBody(
            [
              filePath ? `path: ${filePath}` : null,
              sourceText ? null : outputText,
              "",
              sourceText,
            ],
            filePath || "(file updated)",
          ),
          tone: data.isError ? "red" : "green",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.write,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind:
              data.command === "create"
                ? WATCH_SOURCE_MUTATION_KINDS.create
                : data.command === "insert"
                  ? WATCH_SOURCE_MUTATION_KINDS.insert
                  : WATCH_SOURCE_MUTATION_KINDS.replace,
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
          body: joinDescriptorBody(
            [filePath ? `path: ${filePath}` : null, "", outputText],
            filePath || "(file read)",
          ),
          tone: data.isError ? "red" : "slate",
          previewMode: WATCH_SOURCE_PREVIEW_MODES.read,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            fileRange: data.viewRange,
          }),
        };
      case "undo_edit":
        return {
          title: `Undid ${filePath || "file"}`,
          body: joinDescriptorBody(
            [filePath ? `path: ${filePath}` : null, outputText],
            filePath || "(edit restored)",
          ),
          tone: data.isError ? "red" : "green",
        };
      default:
        return {
          title: `${data.isError ? "Editor failed" : "Editor updated"} ${filePath || "file"}`,
          body: joinDescriptorBody(
            [filePath ? `path: ${filePath}` : null, outputText, "", sourceText],
            filePath || "(editor completed)",
          ),
          tone: data.isError ? "red" : "green",
          previewMode: sourceText ? WATCH_SOURCE_PREVIEW_MODES.write : undefined,
          ...buildSourceMetadata({
            filePath: rawFilePath,
            mutationKind: sourceText ? WATCH_SOURCE_MUTATION_KINDS.write : null,
            mutationAfterText: sourceText,
          }),
        };
    }
  }

  return {
    describeDesktopTextEditorResult,
    describeDesktopTextEditorStart,
  };
}
