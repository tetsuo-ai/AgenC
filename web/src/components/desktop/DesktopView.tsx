import { useState } from 'react';
import type { DesktopSandbox } from '../../hooks/useDesktop';

interface DesktopViewProps {
  sandboxes: DesktopSandbox[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCreate: (sessionId?: string) => void;
  onDestroy: (containerId: string) => void;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'ready':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'starting':
    case 'creating':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
    case 'stopping':
    case 'stopped':
      return 'bg-tetsuo-100 text-tetsuo-500';
    case 'failed':
    case 'unhealthy':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    default:
      return 'bg-tetsuo-100 text-tetsuo-500';
  }
}

function SandboxCard({
  sandbox,
  onDestroy,
}: {
  sandbox: DesktopSandbox;
  onDestroy: (containerId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="bg-surface border border-tetsuo-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${statusColor(sandbox.status)}`}>
            {sandbox.status}
          </span>
          <span className="text-xs text-tetsuo-400 font-mono">{sandbox.containerId}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-tetsuo-500">
        <div>
          <span className="text-tetsuo-400">Session:</span>{' '}
          <span className="font-mono">{sandbox.sessionId.length > 20 ? sandbox.sessionId.slice(0, 20) + '...' : sandbox.sessionId}</span>
        </div>
        <div>
          <span className="text-tetsuo-400">Uptime:</span>{' '}
          {formatUptime(sandbox.uptimeMs)}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        {sandbox.status === 'ready' && (
          <a
            href={sandbox.vncUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-bg text-accent text-xs font-medium hover:opacity-80 transition-opacity"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open VNC
          </a>
        )}
        {confirming ? (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-tetsuo-400">Destroy?</span>
            <button
              onClick={() => { onDestroy(sandbox.containerId); setConfirming(false); }}
              className="px-2 py-1 rounded-md bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-2 py-1 rounded-md bg-tetsuo-100 text-tetsuo-500 text-xs font-medium hover:bg-tetsuo-200 transition-colors"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Destroy
          </button>
        )}
      </div>
    </div>
  );
}

export function DesktopView({
  sandboxes,
  loading,
  error,
  onRefresh,
  onCreate,
  onDestroy,
}: DesktopViewProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Desktop Sandboxes</h2>
            {sandboxes.length > 0 && (
              <div className="text-[10px] text-tetsuo-400 mt-0.5">
                {sandboxes.filter((s) => s.status === 'ready').length} of {sandboxes.length} ready
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onCreate()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Launch Desktop
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90 disabled:opacity-50"
            title="Refresh"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Sandbox list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-2xl mx-auto space-y-3">
          {sandboxes.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-16">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <div className="text-center">
                <p className="text-sm text-tetsuo-500 mb-1">No desktop sandboxes running</p>
                <p className="text-xs text-tetsuo-400">Launch a desktop to get started with autonomous desktop automation</p>
              </div>
              <button
                onClick={() => onCreate()}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Launch Desktop
              </button>
            </div>
          ) : (
            sandboxes.map((sandbox, i) => (
              <div key={sandbox.containerId} className="animate-list-item" style={{ animationDelay: `${i * 40}ms` }}>
                <SandboxCard sandbox={sandbox} onDestroy={onDestroy} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
