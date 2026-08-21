import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type KnowledgeBaseDocumentDto } from '../lib/api.js';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Shared title+content form, used for both "add new" and "edit existing" - identical fields, different submit handler. */
function DocumentForm({
  title,
  content,
  onTitleChange,
  onContentChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  title: string;
  content: string;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel?: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input
        required
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        placeholder={'Title (e.g. "Refund Policy")'}
        maxLength={200}
        className="field border border-border-subtle bg-surface-1 text-fg"
      />
      <textarea
        required
        value={content}
        onChange={(event) => onContentChange(event.target.value)}
        placeholder="What should the AI know? Write it the way you'd explain it to a new employee."
        rows={4}
        maxLength={20_000}
        className="field resize-y border border-border-subtle bg-surface-1 text-fg"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function KnowledgeBaseCard() {
  const [documents, setDocuments] = useState<KnowledgeBaseDocumentDto[] | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    const result = await api.listKnowledgeBaseDocuments();
    setDocuments(result.documents);
  }

  useEffect(() => {
    void load().catch(() => setDocuments([]));
  }, []);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAdding(true);
    setNotice(null);
    try {
      await api.createKnowledgeBaseDocument(newTitle.trim(), newContent.trim());
      setNewTitle('');
      setNewContent('');
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not add that document.' });
    } finally {
      setAdding(false);
    }
  }

  function startEdit(document: KnowledgeBaseDocumentDto) {
    setEditingId(document.id);
    setEditTitle(document.title);
    setEditContent(document.content);
    setNotice(null);
  }

  async function handleSaveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editingId) return;
    setSaving(true);
    setNotice(null);
    try {
      await api.updateKnowledgeBaseDocument(editingId, editTitle.trim(), editContent.trim());
      setEditingId(null);
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save those changes.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(document: KnowledgeBaseDocumentDto) {
    if (!window.confirm(`Delete "${document.title}"? The AI will no longer be able to reference it.`)) return;
    setDeletingId(document.id);
    setNotice(null);
    try {
      await api.deleteKnowledgeBaseDocument(document.id);
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not delete that document.' });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center gap-2">
        <BookOpen size={16} className="text-accent" aria-hidden />
        <h2 className="text-body font-semibold text-fg">Knowledge base</h2>
      </div>
      <p className="mt-1 text-caption text-fg-muted">
        Documents your AI agents can search and cite when replying - real Postgres full-text search over what you write here, never
        fabricated. Add anything a new employee would need to know: policies, hours, pricing, FAQs.
      </p>

      {notice ? (
        <p className={`mt-3 text-caption ${notice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{notice.text}</p>
      ) : null}

      <div className="mt-4 rounded-lg border border-border-subtle bg-surface-1 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <Plus size={13} aria-hidden />
          Add a document
        </div>
        <DocumentForm
          title={newTitle}
          content={newContent}
          onTitleChange={setNewTitle}
          onContentChange={setNewContent}
          onSubmit={handleAdd}
          busy={adding}
          submitLabel="Add"
        />
      </div>

      <div className="mt-4 space-y-2">
        {documents === null ? (
          <p className="text-caption text-fg-muted">Loading...</p>
        ) : documents.length === 0 ? (
          <p className="text-caption text-fg-muted">No documents yet - the AI has nothing to reference until you add one above.</p>
        ) : (
          documents.map((document) => (
            <div key={document.id} className="rounded-lg border border-border-subtle bg-surface-1 p-3">
              {editingId === document.id ? (
                <DocumentForm
                  title={editTitle}
                  content={editContent}
                  onTitleChange={setEditTitle}
                  onContentChange={setEditContent}
                  onSubmit={handleSaveEdit}
                  onCancel={() => setEditingId(null)}
                  busy={saving}
                  submitLabel="Save"
                />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0-safe">
                      <p className="text-caption font-medium text-fg">{document.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-meta text-fg-muted">{document.content}</p>
                      <p className="mt-1 text-meta text-fg-muted">Updated {formatWhen(document.updatedAt)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(document)}
                        aria-label={`Edit ${document.title}`}
                        className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
                      >
                        <Pencil size={13} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(document)}
                        disabled={deletingId === document.id}
                        aria-label={`Delete ${document.title}`}
                        className="rounded-md p-1.5 text-fg-muted hover:text-error disabled:opacity-50"
                      >
                        {deletingId === document.id ? (
                          <Loader2 size={13} className="animate-spin" aria-hidden />
                        ) : (
                          <Trash2 size={13} aria-hidden />
                        )}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
