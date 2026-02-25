import { useCallback, useState } from 'react';

interface DesktopPanelProps {
  vncUrl: string;
  onClose: () => void;
}

export function DesktopPanel({ vncUrl, onClose }: DesktopPanelProps) {
  const [loading, setLoading] = useState(true);

  const iframeSrc = `${vncUrl}?autoconnect=true&resize=scale&view_only=true`;

  const openFullscreen = useCallback(() => {
    window.open(vncUrl, '_blank', 'noopener');
  }, [vncUrl]);

  return (
    <div className="flex flex-col h-full border-l border-tetsuo-200 bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-tetsuo-200 bg-tetsuo-50/50">
        <div className="flex items-center gap-2 text-sm font-medium text-tetsuo-700">
          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
          Desktop
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={openFullscreen}
            className="w-7 h-7 rounded flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors"
            title="Open in new tab"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors"
            title="Close desktop viewer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* iframe container */}
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-tetsuo-50">
            <div className="flex flex-col items-center gap-2 text-tetsuo-400">
              <svg className="animate-spin w-6 h-6" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="text-xs">Connecting to desktop...</span>
            </div>
          </div>
        )}
        <iframe
          src={iframeSrc}
          className="w-full h-full border-0"
          onLoad={() => setLoading(false)}
          allow="clipboard-read; clipboard-write"
          title="Desktop Viewer"
        />
      </div>
    </div>
  );
}
