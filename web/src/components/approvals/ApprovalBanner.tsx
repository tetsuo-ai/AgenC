import type { ApprovalRequest } from '../../types';

interface ApprovalBannerProps {
  pending: ApprovalRequest[];
  onSelect: (request: ApprovalRequest) => void;
}

export function ApprovalBanner({ pending, onSelect }: ApprovalBannerProps) {
  if (pending.length === 0) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/60 px-4 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <span className="font-medium">{pending.length} pending approval{pending.length > 1 ? 's' : ''}</span>
          </div>
          <span className="text-amber-500 dark:text-amber-500/60 hidden sm:inline">
            — {pending[0].action}
          </span>
        </div>
        <button
          onClick={() => onSelect(pending[0])}
          className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/50 font-medium px-3 py-1 rounded-lg transition-colors"
        >
          Review
        </button>
      </div>
    </div>
  );
}
