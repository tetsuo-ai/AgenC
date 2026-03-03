import { useEffect, useState } from 'react';
import type { ApprovalRequest } from '../../types';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onClose: () => void;
}

export function ApprovalDialog({ request, onApprove, onDeny, onClose }: ApprovalDialogProps) {
  const [visible, setVisible] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const hasDetails = Object.keys(request.details).length > 0;

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 150);
  };

  const handleApprove = () => {
    setVisible(false);
    setTimeout(() => onApprove(request.requestId), 150);
  };

  const handleDeny = () => {
    setVisible(false);
    setTimeout(() => onDeny(request.requestId), 150);
  };

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 p-4 transition-colors duration-150 ${
        visible ? 'bg-black/70' : 'bg-transparent'
      }`}
      onClick={handleClose}
    >
      <div
        className={`bg-bbs-dark border border-bbs-yellow/50 max-w-md w-full transition-all duration-200 ${
          visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2 border-b border-bbs-yellow/30 flex items-center justify-between">
          <span className="text-xs text-bbs-yellow font-bold">
            {'\u2524'} APPROVAL REQUIRED {'\u251C'}
          </span>
          <button
            onClick={handleClose}
            className="text-xs text-bbs-gray hover:text-bbs-white transition-colors"
          >
            [X]
          </button>
        </div>

        {/* Action */}
        <div className="px-4 py-3">
          <div className="text-xs text-bbs-gray mb-1">The agent wants to perform:</div>
          <div className="border border-bbs-border bg-bbs-surface px-3 py-2">
            <span className="text-xs font-mono text-bbs-yellow font-bold">{request.action}</span>
          </div>
        </div>

        {/* Details */}
        {hasDetails && (
          <div className="px-4 pb-3">
            <button
              onClick={() => setDetailsExpanded(!detailsExpanded)}
              className="text-xs text-bbs-gray hover:text-bbs-white transition-colors mb-2"
            >
              {detailsExpanded ? '[-] Hide details' : '[+] Show details'}
            </button>
            {detailsExpanded && (
              <pre className="text-xs text-bbs-lightgray bg-bbs-surface border border-bbs-border p-3 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">
                {JSON.stringify(request.details, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="px-4 pb-4 flex gap-3">
          <button
            onClick={handleDeny}
            className="flex-1 text-xs text-bbs-red hover:text-bbs-white border border-bbs-red/40 py-2 font-bold transition-colors text-center"
          >
            [DENY]
          </button>
          <button
            onClick={handleApprove}
            className="flex-1 text-xs text-bbs-green hover:text-bbs-white border border-bbs-green/40 py-2 font-bold transition-colors text-center"
          >
            [APPROVE]
          </button>
        </div>
      </div>
    </div>
  );
}
