import type { ApprovalRequest } from '../../types';

interface ApprovalBannerProps {
  pending: ApprovalRequest[];
  onSelect: (request: ApprovalRequest) => void;
}

export function ApprovalBanner({ pending, onSelect }: ApprovalBannerProps) {
  if (pending.length === 0) return null;

  return (
    <div className="bg-yellow-900/30 border-b border-yellow-700/50 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-yellow-300">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          <span>{pending.length} pending approval{pending.length > 1 ? 's' : ''}</span>
        </div>
        <button
          onClick={() => onSelect(pending[0])}
          className="text-xs text-yellow-400 hover:text-yellow-200 transition-colors"
        >
          Review
        </button>
      </div>
    </div>
  );
}
