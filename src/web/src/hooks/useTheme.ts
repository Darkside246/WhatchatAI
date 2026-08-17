import { useEffect, useState } from 'react';
import { readStoredTheme, storeTheme, THEME_CHANGE_EVENT, type ThemeId } from '../theme.js';

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    function onChange(event: Event) {
      setThemeState((event as CustomEvent<ThemeId>).detail);
    }
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  function setTheme(id: ThemeId) {
    storeTheme(id);
    setThemeState(id);
  }

  return { theme, setTheme };
}
