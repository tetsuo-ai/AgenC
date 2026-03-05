import { useMemo, useState } from 'react';
import type { ToolCall } from '../../types';
import { parseToolResultMedia } from './toolResultMedia';

interface ToolCallCardProps {
  toolCall: ToolCall;
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
  const badge = statusLabel(toolCall);
  const durationLabel = formatDuration(toolCall.durationMs);
  const argCount = Object.keys(toolCall.args).length;

  const media = useMemo(
    () => parseToolResultMedia(toolCall.result),
    [toolCall.result],
  );
  const hasImages = media.imageUrls.length > 0;

  const showContent = expanded || hasImages;

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

          {media.imageUrls.map((imageUrl, idx) => (
            <img
              key={`tool-result-image-${idx}`}
              src={imageUrl}
              alt="Tool result image"
              className="max-w-full border border-bbs-border"
            />
          ))}

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
                {media.redactedText || toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
