import { useState } from 'react';
import type { DesktopCreateOptions, DesktopSandbox } from '../../hooks/useDesktop';

interface DesktopViewProps {
  sandboxes: DesktopSandbox[];
  loading: boolean;
  error: string | null;
  activeSessionId?: string | null;
  onRefresh: () => void;
  onCreate: (options?: DesktopCreateOptions) => void;
  onAttach: (containerId: string, sessionId?: string) => void;
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

function statusTone(status: string): string {
  switch (status) {
    case 'ready':
      return 'border-bbs-green/40 text-bbs-green';
    case 'starting':
    case 'creating':
      return 'border-bbs-yellow/40 text-bbs-yellow';
    case 'stopping':
    case 'stopped':
      return 'border-bbs-border text-bbs-gray';
    case 'failed':
    case 'unhealthy':
      return 'border-bbs-red/40 text-bbs-red';
    default:
      return 'border-bbs-border text-bbs-gray';
  }
}

function SandboxCard({
  sandbox,
  ordinal,
  activeSessionId,
  onAttach,
  onDestroy,
}: {
  sandbox: DesktopSandbox;
  ordinal: number;
  activeSessionId?: string | null;
  onAttach: (containerId: string) => void;
  onDestroy: (containerId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isAssigned = !!activeSessionId && sandbox.sessionId === activeSessionId;

  return (
    <article className="border border-bbs-border bg-bbs-dark px-4 py-4 transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
            <span className="text-bbs-purple">DESKTOP&gt;</span>
            <span>[node:{ordinal}]</span>
            <span className={`border bg-bbs-black px-3 py-2 ${statusTone(sandbox.status)}`}>[{sandbox.status}]</span>
          </div>
          <div className="mt-2 break-all text-sm text-bbs-lightgray">{sandbox.containerId}</div>
        </div>

        {sandbox.status === 'ready' && isAssigned ? (
          <span className="border border-bbs-green/40 bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-green">
            [assigned to chat]
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 text-xs md:grid-cols-2 xl:grid-cols-4">
        <InfoBlock label="session" value={sandbox.sessionId} />
        <InfoBlock label="uptime" value={formatUptime(sandbox.uptimeMs)} />
        <InfoBlock label="ram" value={sandbox.maxMemory ?? 'default'} />
        <InfoBlock label="cpu" value={sandbox.maxCpu ?? 'default'} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em]">
        {sandbox.status === 'ready' ? (
          <a
            href={sandbox.vncUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="border border-bbs-cyan/40 bg-bbs-black px-3 py-2 text-bbs-cyan transition-colors hover:text-bbs-white"
          >
            [open vnc]
          </a>
        ) : null}

        {sandbox.status === 'ready' && !isAssigned ? (
          <button
            type="button"
            onClick={() => onAttach(sandbox.containerId)}
            className="border border-bbs-border bg-bbs-black px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
          >
            [assign to chat]
          </button>
        ) : null}

        {confirming ? (
          <>
            <span className="text-bbs-yellow">[confirm destroy]</span>
            <button
              type="button"
              onClick={() => {
                onDestroy(sandbox.containerId);
                setConfirming(false);
              }}
              className="border border-bbs-red/40 bg-bbs-black px-3 py-2 text-bbs-red transition-colors hover:text-bbs-white"
            >
              [yes]
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="border border-bbs-border bg-bbs-black px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [no]
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="ml-auto border border-bbs-red/40 bg-bbs-black px-3 py-2 text-bbs-red transition-colors hover:text-bbs-white"
          >
            [destroy]
          </button>
        )}
      </div>
    </article>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-bbs-border bg-bbs-black/40 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">{label}</div>
      <div className="mt-2 break-all text-sm text-bbs-lightgray">{value}</div>
    </div>
  );
}

export function DesktopView({
  sandboxes,
  loading,
  error,
  activeSessionId,
  onRefresh,
  onCreate,
  onAttach,
  onDestroy,
}: DesktopViewProps) {
  const [launchMemory, setLaunchMemory] = useState('');
  const [launchCpu, setLaunchCpu] = useState('');

  const handleCreate = () => {
    onCreate({
      maxMemory: launchMemory.trim() || undefined,
      maxCpu: launchCpu.trim() || undefined,
    });
  };

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="border-b border-bbs-border bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="text-bbs-purple">DESKTOP&gt;</span>
              <span>sandbox fleet</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Remote desktop workers
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              provision, assign, and destroy browser-capable desktop sandboxes for agent execution
            </p>
          </div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <input
              value={launchMemory}
              onChange={(event) => setLaunchMemory(event.target.value)}
              placeholder="ram e.g. 4g"
              className="w-full border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-white outline-none placeholder:text-bbs-gray focus:border-bbs-purple-dim md:w-28"
            />
            <input
              value={launchCpu}
              onChange={(event) => setLaunchCpu(event.target.value)}
              placeholder="cpu e.g. 2.0"
              className="w-full border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-white outline-none placeholder:text-bbs-gray focus:border-bbs-purple-dim md:w-28"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={loading}
              className="border border-bbs-green/40 bg-bbs-dark px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-green transition-colors hover:text-bbs-white disabled:opacity-50"
            >
              [launch]
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white disabled:opacity-50"
            >
              {loading ? '[refreshing]' : '[refresh]'}
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="border-b border-bbs-red/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-red md:px-6">
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          {sandboxes.length === 0 ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no desktop sandboxes running]
            </div>
          ) : (
            sandboxes.map((sandbox, index) => (
              <div
                key={sandbox.containerId}
                className="animate-list-item"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <SandboxCard
                  sandbox={sandbox}
                  ordinal={index + 1}
                  activeSessionId={activeSessionId}
                  onAttach={(containerId) => onAttach(containerId, activeSessionId ?? undefined)}
                  onDestroy={onDestroy}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
