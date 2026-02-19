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
        visible ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent'
      }`}
      onClick={handleClose}
    >
      <div
        className={`bg-surface border border-tetsuo-200 rounded-2xl max-w-md w-full shadow-2xl transition-all duration-200 ${
          visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with icon */}
        <div className="px-5 pt-5 pb-3 flex items-start gap-3">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgb(217, 119, 6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-tetsuo-800">Approval Required</h3>
            <p className="text-xs text-tetsuo-400 mt-0.5">The agent wants to perform an action</p>
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Action name */}
        <div className="px-5 pb-3">
          <div className="bg-tetsuo-50 border border-tetsuo-200 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
              <span className="text-sm font-mono font-medium text-tetsuo-800 truncate">{request.action}</span>
            </div>
          </div>
        </div>

        {/* Details (collapsible) */}
        {hasDetails && (
          <div className="px-5 pb-3">
            <button
              onClick={() => setDetailsExpanded(!detailsExpanded)}
              className="flex items-center gap-1.5 text-xs text-tetsuo-400 hover:text-tetsuo-600 transition-colors mb-2"
            >
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className={`transition-transform duration-150 ${detailsExpanded ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Details
            </button>
            {detailsExpanded && (
              <pre className="text-xs text-tetsuo-600 bg-tetsuo-50 border border-tetsuo-200 rounded-xl p-3 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono leading-relaxed">
                {JSON.stringify(request.details, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="px-5 pb-5 flex gap-2">
          <button
            onClick={handleDeny}
            className="flex-1 px-4 py-2.5 bg-tetsuo-50 border border-tetsuo-200 text-tetsuo-600 rounded-xl text-sm font-medium hover:bg-red-50 hover:border-red-200 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:border-red-800 dark:hover:text-red-400 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={handleApprove}
            className="flex-1 px-4 py-2.5 bg-accent text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
