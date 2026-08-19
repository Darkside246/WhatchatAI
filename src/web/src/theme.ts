export type ThemeId = 'sleek' | 'dark' | 'light' | 'midnight' | 'forest' | 'sunset';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  /** The chat-area doodle background class this theme uses (index.css). */
  doodleClass: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'sleek', name: 'Sleek Interface', doodleClass: 'chat-sleek-bg' },
  { id: 'dark', name: 'WhatsApp Dark', doodleClass: 'chat-doodle-bg' },
  { id: 'light', name: 'WhatsApp Light', doodleClass: 'chat-doodle-light-bg' },
  { id: 'midnight', name: 'Midnight AMOLED', doodleClass: 'chat-doodle-bg' },
  { id: 'forest', name: 'Deep Forest', doodleClass: 'chat-doodle-bg' },
  { id: 'sunset', name: 'Sunset Plum', doodleClass: 'chat-doodle-bg' },
];

const STORAGE_KEY = 'whatchatai-theme';

/** Fires whenever the active theme changes, so every mounted useTheme() consumer stays in sync without a remount. */
export const THEME_CHANGE_EVENT = 'whatchatai-theme-change';

export function readStoredTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  return THEMES.some((t) => t.id === stored) ? (stored as ThemeId) : 'sleek';
}

/** Sets the real DOM attribute every themed token in index.css reads from - the single source of truth for the active palette. */
export function applyTheme(id: ThemeId): void {
  if (id === 'sleek') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = id;
  }
}

/**
 * Applies whatever theme was last chosen before React ever renders, so a
 * returning user with a saved dark/midnight/etc. theme never sees a flash
 * of the default "Sleek Interface" palette on load.
 */
export function applyStoredThemeOnBoot(): void {
  applyTheme(readStoredTheme());
}

export function storeTheme(id: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, id);
  applyTheme(id);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: id }));
}
