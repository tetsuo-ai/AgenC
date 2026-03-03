import type { ApprovalRequest } from '../../types';

interface ApprovalBannerProps {
  pending: ApprovalRequest[];
  onSelect: (request: ApprovalRequest) => void;
}

export function ApprovalBanner({ pending, onSelect }: ApprovalBannerProps) {
  if (pending.length === 0) return null;

  return (
    <div className="bg-bbs-dark border-b border-bbs-yellow/30 px-4 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-bbs-yellow">
          !! APPROVAL REQUIRED: {pending[0].action} -- {pending.length} pending
        </span>
        <button
          onClick={() => onSelect(pending[0])}
          className="text-xs text-bbs-yellow hover:text-bbs-white font-bold transition-colors"
        >
          [REVIEW]
        </button>
      </div>
    </div>
  );
}
