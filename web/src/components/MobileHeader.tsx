interface MobileHeaderProps {
  onMenuToggle: () => void;
}

export function MobileHeader({ onMenuToggle }: MobileHeaderProps) {
  return (
    <div className="relative flex md:hidden items-center justify-end px-4 py-3 bg-tetsuo-50 border-b border-tetsuo-200">
      {/* Menu button */}
      <button
        onClick={onMenuToggle}
        className="w-10 h-10 rounded-full flex items-center justify-center text-tetsuo-500 hover:bg-tetsuo-100 transition-colors"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </div>
  );
}
