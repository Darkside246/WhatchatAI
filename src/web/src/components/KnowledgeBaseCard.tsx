import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, FileText, Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { api, ApiError, type KnowledgeBaseDocumentDto, type BusinessDocumentDto } from '../lib/api.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
]);
const ALLOWED_EXTENSIONS = '.pdf,.docx,.txt,.csv';
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [tab, setTab] = useState<'docs' | 'files'>('docs');

  // ── Text documents ─────────────────────────────────────────────────────────
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

  // ── Uploaded files ─────────────────────────────────────────────────────────
  const [files, setFiles] = useState<BusinessDocumentDto[] | null>(null);
  const [fileNotice, setFileNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadDocs() {
    const result = await api.listKnowledgeBaseDocuments();
    setDocuments(result.documents);
  }
  async function loadFiles() {
    const result = await api.listBusinessDocuments();
    setFiles(result.documents);
  }

  useEffect(() => {
    void loadDocs().catch(() => setDocuments([]));
    void loadFiles().catch(() => setFiles([]));
  }, []);

  // ── Text doc handlers ──────────────────────────────────────────────────────
  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAdding(true); setNotice(null);
    try {
      await api.createKnowledgeBaseDocument(newTitle.trim(), newContent.trim());
      setNewTitle(''); setNewContent('');
      await loadDocs();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not add that document.' });
    } finally { setAdding(false); }
  }

  function startEdit(document: KnowledgeBaseDocumentDto) {
    setEditingId(document.id); setEditTitle(document.title); setEditContent(document.content); setNotice(null);
  }

  async function handleSaveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editingId) return;
    setSaving(true); setNotice(null);
    try {
      await api.updateKnowledgeBaseDocument(editingId, editTitle.trim(), editContent.trim());
      setEditingId(null); await loadDocs();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save those changes.' });
    } finally { setSaving(false); }
  }

  async function handleDelete(document: KnowledgeBaseDocumentDto) {
    if (!window.confirm(`Delete "${document.title}"? The AI will no longer be able to reference it.`)) return;
    setDeletingId(document.id); setNotice(null);
    try { await api.deleteKnowledgeBaseDocument(document.id); await loadDocs(); }
    catch (err) { setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not delete that document.' }); }
    finally { setDeletingId(null); }
  }

  // ── File upload handlers ───────────────────────────────────────────────────
  async function handleFileSelected(file: File) {
    setFileNotice(null);
    if (!ALLOWED_MIME.has(file.type)) {
      setFileNotice({ kind: 'error', text: `File type not supported. Accepted: PDF, Word (.docx), plain text, CSV.` });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileNotice({ kind: 'error', text: `File is too large (${formatFileSize(file.size)}). Maximum is 15 MB.` });
      return;
    }
    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      await api.uploadBusinessDocument(file.name, file.type, fileBase64);
      await loadFiles();
      setFileNotice({ kind: 'ok', text: `"${file.name}" uploaded successfully. It will be scanned and indexed shortly.` });
    } catch (err) {
      setFileNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Upload failed. Please try again.' });
    } finally { setUploading(false); }
  }

  async function handleDeleteFile(file: BusinessDocumentDto) {
    if (!window.confirm(`Delete "${file.filename}"?`)) return;
    setDeletingFileId(file.id);
    try { await api.deleteBusinessDocument(file.id); await loadFiles(); }
    catch { setFileNotice({ kind: 'error', text: 'Could not delete that file.' }); }
    finally { setDeletingFileId(null); }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-accent" aria-hidden />
          <h2 className="text-body font-semibold text-fg">Knowledge base</h2>
        </div>
        {/* Tab switcher */}
        <div className="flex rounded-lg border border-border-subtle bg-surface-1 p-0.5">
          {(['docs', 'files'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-meta font-medium transition ${tab === t ? 'bg-surface-2 text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}>
              {t === 'docs' ? 'Text docs' : 'Files'}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-1 text-caption text-fg-muted">
        {tab === 'docs'
          ? 'Write anything your AI agents should know — policies, FAQs, pricing. Real Postgres full-text search, never fabricated.'
          : 'Upload PDFs, Word docs, or CSV files (max 15 MB each). Files are scanned before indexing.'}
      </p>

      {/* ── Text docs tab ── */}
      {tab === 'docs' && (
        <>
          {notice ? <p className={`mt-2 text-caption ${notice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{notice.text}</p> : null}
          <div className="mt-3 rounded-lg border border-border-subtle bg-surface-1 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
              <Plus size={12} aria-hidden /> Add a document
            </div>
            <DocumentForm title={newTitle} content={newContent} onTitleChange={setNewTitle} onContentChange={setNewContent} onSubmit={handleAdd} busy={adding} submitLabel="Add" />
          </div>
          <div className="mt-3 space-y-2">
            {documents === null
              ? <p className="text-caption text-fg-muted">Loading…</p>
              : documents.length === 0
              ? <p className="text-caption text-fg-muted">No documents yet — the AI has nothing to reference until you add one above.</p>
              : documents.map((document) => (
                <div key={document.id} className="rounded-lg border border-border-subtle bg-surface-1 p-3">
                  {editingId === document.id ? (
                    <DocumentForm title={editTitle} content={editContent} onTitleChange={setEditTitle} onContentChange={setEditContent}
                      onSubmit={handleSaveEdit} onCancel={() => setEditingId(null)} busy={saving} submitLabel="Save" />
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-caption font-medium text-fg">{document.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-meta text-fg-muted">{document.content}</p>
                        <p className="mt-1 text-meta text-fg-muted">Updated {formatWhen(document.updatedAt)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => startEdit(document)} aria-label={`Edit ${document.title}`}
                          className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"><Pencil size={13} aria-hidden /></button>
                        <button type="button" onClick={() => void handleDelete(document)} disabled={deletingId === document.id}
                          aria-label={`Delete ${document.title}`} className="rounded-md p-1.5 text-fg-muted hover:text-error disabled:opacity-50">
                          {deletingId === document.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            }
          </div>
        </>
      )}

      {/* ── Files tab ── */}
      {tab === 'files' && (
        <>
          {fileNotice ? <p className={`mt-2 text-caption ${fileNotice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{fileNotice.text}</p> : null}
          <div className="mt-3">
            <input ref={fileInputRef} type="file" accept={ALLOWED_EXTENSIONS} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handleFileSelected(f); }} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50">
              {uploading ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Upload size={13} aria-hidden />}
              {uploading ? 'Uploading…' : 'Upload file'}
            </button>
            <p className="mt-1 text-meta text-fg-muted">Accepted: PDF, Word (.docx), plain text (.txt), CSV · max 15 MB · scanned for safety before indexing</p>
          </div>
          <div className="mt-3 space-y-2">
            {files === null
              ? <p className="text-caption text-fg-muted">Loading…</p>
              : files.length === 0
              ? <p className="text-caption text-fg-muted">No files uploaded yet.</p>
              : files.map((file) => (
                <div key={file.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText size={14} className="shrink-0 text-fg-muted" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-caption font-medium text-fg">{file.filename}</p>
                      <p className="text-meta text-fg-muted">Uploaded {formatWhen(file.createdAt)} · {file.status}</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => void handleDeleteFile(file)} disabled={deletingFileId === file.id}
                    aria-label={`Delete ${file.filename}`} className="shrink-0 rounded-md p-1.5 text-fg-muted hover:text-error disabled:opacity-50">
                    {deletingFileId === file.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
                  </button>
                </div>
              ))
            }
          </div>
        </>
      )}
    </section>
  );
}
