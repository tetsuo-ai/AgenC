interface MobileHeaderProps {
  onMenuToggle: () => void;
}

// MobileHeader is no longer used in the BBS layout (BBSMenuBar handles mobile nav
// via horizontal scroll). Kept as a stub to avoid breaking any existing imports.
export function MobileHeader({ onMenuToggle: _onMenuToggle }: MobileHeaderProps) {
  return null;
}
