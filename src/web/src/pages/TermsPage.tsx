import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';

export function TermsPage() {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<{ title: string; contentHtml: string; version: string; effectiveAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getLegalDocuments()
      .then((docs) => setDoc(docs.terms))
      .catch(() => setError('Could not load Terms of Service.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-full bg-surface-0 text-fg">
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-surface-0/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-caption text-fg-secondary hover:bg-surface-2"
          >
            <ArrowLeft size={14} aria-hidden />
            Back
          </button>
          <div className="flex items-center gap-2 text-body font-semibold text-fg">
            <FileText size={16} className="text-accent" aria-hidden />
            Terms of Service
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-10">
        {loading && (
          <div className="flex items-center gap-2 text-body text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Loading…
          </div>
        )}

        {error && <p className="text-body text-error">{error}</p>}

        {doc && (
          <>
            <h1 className="text-2xl font-semibold text-fg">{doc.title}</h1>
            <p className="mt-1.5 text-caption text-fg-muted">
              Version {doc.version} · Effective {new Date(doc.effectiveAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
            <div
              className="legal-prose mt-8"
              dangerouslySetInnerHTML={{ __html: doc.contentHtml }}
            />
          </>
        )}
      </section>

      <style>{`
        .legal-prose h2 {
          font-size: 1.05rem;
          font-weight: 600;
          margin-top: 2rem;
          margin-bottom: 0.5rem;
          color: var(--fg);
        }
        .legal-prose p {
          margin-bottom: 1rem;
          line-height: 1.7;
          color: var(--fg-secondary);
          font-size: 0.9375rem;
        }
        .legal-prose a {
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .legal-prose a:hover { opacity: 0.8; }
      `}</style>
    </main>
  );
}
