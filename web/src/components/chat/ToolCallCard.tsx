import { useMemo, useState } from 'react';
import type { ToolCall } from '../../types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

/** Try to extract a data URL from a screenshot tool result JSON.
 *  Handles both direct `{dataUrl, image}` and wrapped `{content: "{...}"}` shapes. */
function extractScreenshot(result: string | undefined): string | null {
  if (!result) return null;
  try {
    let obj = JSON.parse(result) as Record<string, unknown>;
    // Unwrap ToolResult wrapper: { content: "{\"image\":\"...\"}" }
    if (typeof obj.content === 'string') {
      try {
        obj = JSON.parse(obj.content) as Record<string, unknown>;
      } catch {
        // content isn't JSON — leave obj as-is
      }
    }
    if (typeof obj.dataUrl === 'string' && obj.dataUrl.startsWith('data:image/')) {
      return obj.dataUrl;
    }
    if (typeof obj.image === 'string' && obj.image.length > 100) {
      return `data:image/png;base64,${obj.image}`;
    }
  } catch {
    // Not JSON — ignore
  }
  return null;
}

/** Produce a display-friendly version of the result, stripping huge base64 blobs.
 *  Handles both direct and `{content: "{...}"}` wrapped shapes. */
function summarizeResult(result: string): string {
  try {
    let parsed = JSON.parse(result) as Record<string, unknown>;
    // Unwrap ToolResult wrapper
    if (typeof parsed.content === 'string') {
      try {
        parsed = JSON.parse(parsed.content) as Record<string, unknown>;
      } catch { /* leave as-is */ }
    }
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((key === 'image' || key === 'dataUrl') && typeof value === 'string' && value.length > 200) {
        summary[key] = `<${Math.round(value.length / 1024)}KB base64>`;
      } else {
        summary[key] = value;
      }
    }
    return JSON.stringify(summary, null, 2);
  } catch {
    return result;
  }
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = toolCall.status === 'executing';
  const isScreenshot = toolCall.toolName === 'desktop.screenshot';

  const screenshotUrl = useMemo(
    () => (isScreenshot ? extractScreenshot(toolCall.result) : null),
    [isScreenshot, toolCall.result],
  );

  // Auto-expand screenshot results so the image is visible immediately
  const showContent = expanded || (isScreenshot && screenshotUrl !== null);

  return (
    <div className="mt-2 rounded-xl border border-tetsuo-200 bg-surface text-xs overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-tetsuo-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExecuting ? (
            <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          ) : toolCall.isError ? (
            <span className="w-2 h-2 rounded-full bg-red-500" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-green-500" />
          )}
          <span className="text-accent font-semibold">{toolCall.toolName}</span>
        </div>
        <div className="flex items-center gap-2 text-tetsuo-400">
          {toolCall.durationMs !== undefined && (
            <span>{toolCall.durationMs}ms</span>
          )}
          <span>{showContent ? '\u25B2' : '\u25BC'}</span>
        </div>
      </button>

      {showContent && (
        <div className="border-t border-tetsuo-200 px-3 py-2.5 space-y-2">
          {Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-tetsuo-400 mb-1 font-medium">Arguments:</div>
              <pre className="text-tetsuo-600 whitespace-pre-wrap break-all bg-tetsuo-50 rounded-lg p-2.5">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}

          {/* Inline screenshot image */}
          {screenshotUrl && (
            <div>
              <img
                src={screenshotUrl}
                alt="Desktop screenshot"
                className="max-w-full rounded-lg border border-tetsuo-200"
              />
            </div>
          )}

          {toolCall.result && (
            <div>
              <div className="text-tetsuo-400 mb-1 font-medium">
                {toolCall.isError ? 'Error:' : 'Result:'}
              </div>
              <pre className={`whitespace-pre-wrap break-all rounded-lg p-2.5 bg-tetsuo-50 ${toolCall.isError ? 'text-red-500' : 'text-tetsuo-600'}`}>
                {screenshotUrl ? summarizeResult(toolCall.result) : toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
