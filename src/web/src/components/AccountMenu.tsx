import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Always-visible account entry point in the workspace header. Sign out
 * previously only existed three clicks deep in Settings > Account &
 * Security, with no visible way back to the login screen short of an
 * incognito window - this is the standard top-right avatar/menu pattern
 * instead.
 */
export function AccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const name = auth.user?.displayName || auth.user?.email || 'Account';

  async function handleSignOut() {
    setOpen(false);
    await auth.logout();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-1 pl-1 pr-2 hover:bg-surface-3"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-meta font-semibold text-white">{initials(name)}</span>
        <span className="hidden max-w-[9rem] truncate text-caption font-medium text-fg-secondary md:inline">{name}</span>
        <ChevronDown size={13} aria-hidden className="text-fg-muted" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-10 z-40 w-56 rounded-xl border border-border-subtle bg-surface-2 py-1 shadow-2xl">
          <div className="border-b border-border-subtle px-3 py-2">
            <p className="truncate text-caption font-medium text-fg">{auth.user?.displayName ?? 'Account'}</p>
            <p className="truncate text-meta text-fg-muted">{auth.user?.email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); navigate('/settings'); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-caption text-fg-secondary hover:bg-surface-3"
          >
            <SettingsIcon size={14} aria-hidden />
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-caption text-error hover:bg-surface-3"
          >
            <LogOut size={14} aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
