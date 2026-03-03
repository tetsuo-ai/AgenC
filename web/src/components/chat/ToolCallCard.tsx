import { useMemo, useState } from 'react';
import type { ToolCall } from '../../types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

function extractScreenshot(result: string | undefined): string | null {
  if (!result) return null;
  try {
    let obj = JSON.parse(result) as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      try {
        obj = JSON.parse(obj.content) as Record<string, unknown>;
      } catch { /* */ }
    }
    if (typeof obj.dataUrl === 'string' && obj.dataUrl.startsWith('data:image/')) {
      return obj.dataUrl;
    }
    if (typeof obj.image === 'string' && obj.image.length > 100) {
      return `data:image/png;base64,${obj.image}`;
    }
  } catch { /* */ }
  return null;
}

function summarizeResult(result: string): string {
  try {
    let parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed.content === 'string') {
      try {
        parsed = JSON.parse(parsed.content) as Record<string, unknown>;
      } catch { /* */ }
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

function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function statusLabel(toolCall: ToolCall): { text: string; color: string } {
  if (toolCall.status === 'executing') {
    return { text: '[...]', color: 'text-bbs-yellow animate-pulse' };
  }
  if (toolCall.isError) {
    return { text: '[FAIL]', color: 'text-bbs-red' };
  }
  return { text: '[DONE]', color: 'text-bbs-green' };
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isScreenshot = toolCall.toolName === 'desktop.screenshot';
  const badge = statusLabel(toolCall);
  const durationLabel = formatDuration(toolCall.durationMs);
  const argCount = Object.keys(toolCall.args).length;

  const screenshotUrl = useMemo(
    () => (isScreenshot ? extractScreenshot(toolCall.result) : null),
    [isScreenshot, toolCall.result],
  );

  const showContent = expanded || (isScreenshot && screenshotUrl !== null);

  return (
    <div className="mt-1">
      {/* Summary line */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-xs hover:bg-bbs-surface/50 transition-colors py-0.5 text-left"
      >
        <span className="text-bbs-gray">*</span>
        <span className="text-bbs-cyan truncate">{toolCall.toolName}</span>
        {argCount > 0 && (
          <span className="text-bbs-gray">[{argCount} args]</span>
        )}
        <span className="flex-1" />
        <span className={badge.color}>{badge.text}</span>
        {durationLabel && (
          <span className="text-bbs-gray font-mono">{durationLabel}</span>
        )}
      </button>

      {/* Expanded detail */}
      {showContent && (
        <div className="ml-4 mt-1 space-y-1.5 text-xs">
          {Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-bbs-gray mb-0.5">Arguments:</div>
              <pre className="whitespace-pre-wrap break-all bg-bbs-dark border border-bbs-border p-2 text-bbs-lightgray text-[11px]">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}

          {screenshotUrl && (
            <img
              src={screenshotUrl}
              alt="Desktop screenshot"
              className="max-w-full border border-bbs-border"
            />
          )}

          {toolCall.result && (
            <div>
              <div className={`mb-0.5 ${toolCall.isError ? 'text-bbs-red' : 'text-bbs-gray'}`}>
                {toolCall.isError ? 'Error:' : 'Result:'}
              </div>
              <pre
                className={`whitespace-pre-wrap break-all p-2 text-[11px] border ${
                  toolCall.isError
                    ? 'border-bbs-red/40 bg-bbs-dark text-bbs-red'
                    : 'border-bbs-border bg-bbs-dark text-bbs-lightgray'
                }`}
              >
                {screenshotUrl ? summarizeResult(toolCall.result) : toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
