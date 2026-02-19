import { useState } from 'react';
import type { ToolCall } from '../../types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isExecuting = toolCall.status === 'executing';

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
          <span>{expanded ? '\u25B2' : '\u25BC'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-tetsuo-200 px-3 py-2.5 space-y-2">
          {Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-tetsuo-400 mb-1 font-medium">Arguments:</div>
              <pre className="text-tetsuo-600 whitespace-pre-wrap break-all bg-tetsuo-50 rounded-lg p-2.5">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <div className="text-tetsuo-400 mb-1 font-medium">
                {toolCall.isError ? 'Error:' : 'Result:'}
              </div>
              <pre className={`whitespace-pre-wrap break-all rounded-lg p-2.5 bg-tetsuo-50 ${toolCall.isError ? 'text-red-500' : 'text-tetsuo-600'}`}>
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
