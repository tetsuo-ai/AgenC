import { useCallback, useEffect } from 'react';

type Theme = 'dark';

export function useTheme() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const toggle = useCallback(() => {
    // BBS terminal is always dark — toggle is a no-op
  }, []);

  return { theme: 'dark' as Theme, toggle };
}
