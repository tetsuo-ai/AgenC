interface MobileHeaderProps {
  onMenuToggle: () => void;
}

export function MobileHeader({ onMenuToggle }: MobileHeaderProps) {
  return (
    <div className="flex md:hidden items-center justify-between px-4 py-3 bg-tetsuo-50 border-b border-tetsuo-200">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-8 h-8 dark:hidden" />
        <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-8 h-8 hidden dark:block" />
        <img src="/assets/agenc-wordmark.svg" alt="AgenC" className="h-4 dark:invert opacity-90" />
      </div>

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
