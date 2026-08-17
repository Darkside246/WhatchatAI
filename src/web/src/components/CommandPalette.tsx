import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MessageCircle, User, TrendingUp, Megaphone, Workflow } from 'lucide-react';
import { api, type GlobalSearchResult } from '../lib/api.js';

const TYPE_ICON: Record<GlobalSearchResult['type'], typeof MessageCircle> = {
  chat: MessageCircle,
  contact: User,
  lead: TrendingUp,
  campaign: Megaphone,
  funnel: Workflow,
};

const TYPE_LABEL: Record<GlobalSearchResult['type'], string> = {
  chat: 'Chat',
  contact: 'Contact',
  lead: 'Lead',
  campaign: 'Campaign',
  funnel: 'Funnel',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A real global search over the business's own chats/contacts/leads/
 * campaigns/funnels (see globalSearchService.ts) - never a client-side
 * filter over a partial, already-loaded list. Opens with Cmd/Ctrl+K from
 * anywhere in the workspace, or the header search button.
 */
export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      } else if (event.key === 'Escape') {
        onOpenChange(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      api
        .globalSearch(term)
        .then((res) => {
          setResults(res.results);
          setActiveIndex(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open]);

  function go(result: GlobalSearchResult) {
    onOpenChange(false);
    navigate(result.url);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault();
      go(results[activeIndex]);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border-subtle bg-surface-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <Search size={16} className="shrink-0 text-fg-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search chats, contacts, leads, campaigns, and funnels"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search chats, contacts, leads, campaigns, funnels…"
            className="w-full bg-transparent text-body text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-meta text-fg-muted">Esc</kbd>
        </div>

        <div className="max-h-96 overflow-y-auto" aria-live="polite">
          {query.trim().length >= 2 && results.length === 0 && (
            <p className="px-3 py-6 text-center text-caption text-fg-muted">No matches.</p>
          )}
          {results.map((result, index) => {
            const Icon = TYPE_ICON[result.type];
            return (
              <button
                key={`${result.type}-${result.id}`}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => go(result)}
                className={`flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-2.5 text-left last:border-b-0 ${
                  index === activeIndex ? 'bg-accent-soft' : 'hover:bg-surface-3'
                }`}
              >
                <Icon size={14} className="shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body text-fg">{result.title}</p>
                  {result.subtitle && <p className="truncate text-caption text-fg-muted">{result.subtitle}</p>}
                </div>
                <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-meta text-fg-secondary">{TYPE_LABEL[result.type]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
