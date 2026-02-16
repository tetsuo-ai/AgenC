import type { ApprovalRequest } from '../../types';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onClose: () => void;
}

export function ApprovalDialog({ request, onApprove, onDeny, onClose }: ApprovalDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-tetsuo-900 border border-tetsuo-700 rounded-lg max-w-md w-full shadow-xl">
        <div className="px-6 py-4 border-b border-tetsuo-700">
          <h3 className="text-sm font-semibold text-tetsuo-200">Approval Required</h3>
        </div>

        <div className="px-6 py-4 space-y-3">
          <div>
            <div className="text-xs text-tetsuo-500 mb-1">Action</div>
            <div className="text-sm text-tetsuo-100 font-medium">{request.action}</div>
          </div>

          {Object.keys(request.details).length > 0 && (
            <div>
              <div className="text-xs text-tetsuo-500 mb-1">Details</div>
              <pre className="text-xs text-tetsuo-300 bg-tetsuo-800 rounded p-3 whitespace-pre-wrap break-all">
                {JSON.stringify(request.details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-tetsuo-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-tetsuo-400 hover:text-tetsuo-200 transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => onDeny(request.requestId)}
            className="px-4 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded text-sm hover:bg-red-500/30 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => onApprove(request.requestId)}
            className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-dark transition-colors"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
