import { useCallback, useEffect, useRef, useState } from 'react';

const DESKTOP_IFRAME_LOAD_TIMEOUT_MS = 8_000;

interface DesktopPanelProps {
  vncUrl: string;
  onClose: () => void;
}

export function DesktopPanel({ vncUrl, onClose }: DesktopPanelProps) {
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const iframeSrc = `${vncUrl}?autoconnect=true&resize=scale&view_only=false&show_dot=true`;

  const openFullscreen = useCallback(() => {
    window.open(vncUrl, '_blank', 'noopener');
  }, [vncUrl]);

  const handleContainerClick = useCallback(() => {
    iframeRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), DESKTOP_IFRAME_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col h-full border-l border-bbs-purple-dim bg-bbs-black">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-bbs-purple-dim bg-bbs-purple-dim/20">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-bbs-white">{'\u2524'} DESKTOP VIEWER {'\u251C'}</span>
          <span className="text-bbs-green font-bold">[LIVE]</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={openFullscreen}
            className="text-bbs-gray hover:text-bbs-white transition-colors"
            title="Open in new tab"
          >
            [EXPAND]
          </button>
          <button
            onClick={onClose}
            className="text-bbs-gray hover:text-bbs-red transition-colors"
            title="Close desktop viewer"
          >
            [X]
          </button>
        </div>
      </div>

      {/* iframe container */}
      <div role="presentation" className="relative flex-1 min-h-0" onClick={handleContainerClick}>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bbs-black pointer-events-none">
            <span className="text-xs text-bbs-gray animate-pulse">Connecting to desktop...</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
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
