import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles, Pencil, RotateCcw, Check, ShieldAlert } from 'lucide-react';
import { api, ApiError, type BrandDnaProfileDto, type BrandDnaQuestionDto } from '../lib/api.js';

/**
 * Brand DNA onboarding.
 *
 * Presented as a conversation rather than a form, because the brief's two
 * requirements - cover roughly thirty profile fields, and never feel like a
 * thirty-question survey - are only compatible if the owner sees ONE thing at
 * a time and the depth comes from follow-ups that react to what they said.
 *
 * So: one question on screen, previous exchanges scrolled above it like a
 * chat, a visible Skip on every question, and no progress bar counting down
 * from thirty. The count shown is answers given, not questions remaining -
 * there is no fixed total, since the adaptive follow-ups depend on the
 * answers.
 */

const FIELD_LABELS: { key: keyof BrandDnaProfileDto; label: string }[] = [
  { key: 'brandIdentity', label: 'Business' },
  { key: 'targetCustomer', label: 'Audience' },
  { key: 'positioning', label: 'Positioning' },
  { key: 'brandPersonality', label: 'Personality' },
  { key: 'toneOfVoice', label: 'Voice' },
  { key: 'brandValues', label: 'Values' },
  { key: 'marketingPriorities', label: 'Marketing focus' },
  { key: 'socialChannels', label: 'Main channels' },
  { key: 'differentiators', label: 'What makes you different' },
  { key: 'ownerPersonality', label: 'Your style' },
  { key: 'customerProblems', label: 'Problems you solve' },
  { key: 'competitiveAdvantages', label: 'Advantages' },
  { key: 'preferredVocabulary', label: 'Words to favour' },
  { key: 'wordsToAvoid', label: 'Words to avoid' },
  { key: 'customerExpectations', label: 'Customer expectations' },
  { key: 'localContext', label: 'Local context' },
  { key: 'contentPreferences', label: 'Content style' },
  { key: 'brandStory', label: 'Brand story' },
  { key: 'marketingOpportunities', label: 'Marketing opportunities' },
  { key: 'contentAngles', label: 'Content angles' },
  { key: 'growthOpportunities', label: 'Growth opportunities' },
];

interface Exchange {
  question: string;
  answer: string | null;
}

export function BrandDnaPage() {
  const [question, setQuestion] = useState<BrandDnaQuestionDto | null>(null);
  const [profile, setProfile] = useState<BrandDnaProfileDto | null>(null);
  const [history, setHistory] = useState<Exchange[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [readyToSynthesise, setReadyToSynthesise] = useState(false);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Partial<Record<keyof BrandDnaProfileDto, string>>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [state, existing] = await Promise.all([api.getBrandDnaFlow(), api.getBrandDnaProfile()]);
      setQuestion(state.question);
      setAnsweredCount(state.answeredCount);
      setReadyToSynthesise(state.readyToSynthesise);
      setProfile(existing.profile);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your Brand DNA.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the caret in the box between questions - the same reason the chat
  // composer holds focus. A question that arrives and steals focus makes the
  // flow feel like a form.
  useEffect(() => {
    if (question?.kind === 'text' && !busy) inputRef.current?.focus();
  }, [question, busy]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, question]);

  async function send(answerText: string | null, skipped: boolean) {
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await api.submitBrandDnaAnswer({
        questionKey: question.key,
        questionText: question.prompt,
        answerText,
        skipped,
      });
      setHistory((previous) => [...previous, { question: question.prompt, answer: skipped ? null : answerText }]);
      setQuestion(state.question);
      setAnsweredCount(state.answeredCount);
      setReadyToSynthesise(state.readyToSynthesise);
      setDraft('');
      setSelected([]);
    } catch (err) {
      // A rejected credential is the one error worth showing prominently -
      // it is the owner's cue to rephrase, not a system failure.
      setError(err instanceof ApiError ? err.message : 'Could not save that answer.');
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (question?.kind === 'choice') {
      if (selected.length === 0) return;
      void send(selected.join(', '), false);
      return;
    }
    if (draft.trim().length === 0) return;
    void send(draft.trim(), false);
  }

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      const result = await api.buildBrandDna();
      setProfile(result.profile);
      setQuestion(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build your Brand DNA.');
    } finally {
      setBuilding(false);
    }
  }

  async function saveEdits() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.editBrandDna(edits);
      setProfile(result.profile);
      setEditing(false);
      setEdits({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those changes.');
    } finally {
      setBusy(false);
    }
  }

  async function startOver() {
    setBusy(true);
    try {
      await api.resetBrandDna();
      setHistory([]);
      setProfile(null);
      setEditing(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="p-6 text-caption text-fg-muted">Loading…</div>;

  const showProfile = profile?.status === 'complete' && !question;

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col p-4">
      <header className="mb-3">
        <h1 className="flex items-center gap-2 text-body font-semibold text-fg">
          <Sparkles size={16} className="text-accent" aria-hidden />
          Brand DNA
        </h1>
        <p className="text-meta text-fg-muted">
          {showProfile
            ? 'What Aura knows about your business. Edit anything that is not quite right.'
            : 'A few quick questions so Aura sounds like your business, not like generic AI.'}
        </p>
      </header>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-error" aria-hidden />
          <p className="text-caption text-error">{error}</p>
        </div>
      )}

      {!showProfile && (
        <>
          <div ref={scrollRef} className="mb-3 flex-1 space-y-3 overflow-y-auto">
            {history.length === 0 && (
              <div className="rounded-xl border border-border-subtle bg-surface-1 p-3">
                <p className="text-caption text-fg-secondary">
                  Before we start, I want to get to know you and your business a little. Nothing complicated — just a
                  few quick questions. You can answer briefly, or skip anything that does not apply.
                </p>
                <p className="mt-2 text-meta text-fg-muted">
                  Please do not enter passwords, government ID numbers, banking or card details, or private access
                  codes. Aura never needs them, and they should not be stored in a business system.
                </p>
              </div>
            )}

            {history.map((exchange, index) => (
              <div key={index} className="space-y-1">
                <p className="text-caption text-fg-secondary">{exchange.question}</p>
                <p className="ml-auto w-fit max-w-[85%] rounded-xl bg-accent px-3 py-1.5 text-caption text-white">
                  {exchange.answer ?? <span className="italic opacity-80">Skipped</span>}
                </p>
              </div>
            ))}

            {question && <p className="text-caption font-medium text-fg">{question.prompt}</p>}
            {question?.helper && <p className="text-meta text-fg-muted">{question.helper}</p>}
          </div>

          {question && (
            <form onSubmit={handleSubmit} className="space-y-2 border-t border-border-subtle pt-3">
              {question.kind === 'choice' ? (
                <div className="flex flex-wrap gap-1.5">
                  {question.options?.map((option) => {
                    const on = selected.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() =>
                          setSelected((previous) =>
                            on ? previous.filter((value) => value !== option) : [...previous, option],
                          )
                        }
                        className={`rounded-full border px-3 py-1 text-caption transition ${
                          on
                            ? 'border-accent bg-accent text-white'
                            : 'border-border-subtle bg-surface-2 text-fg hover:border-accent'
                        }`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Type your answer…"
                  className="block w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
                />
              )}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || (question.kind === 'choice' ? selected.length === 0 : draft.trim().length === 0)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Send'}
                </button>
                {/* Always available, never styled as a lesser choice - the
                    brief is explicit that skipping must not be punished. */}
                <button
                  type="button"
                  onClick={() => void send(null, true)}
                  disabled={busy}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg-muted hover:bg-surface-2 disabled:opacity-50"
                >
                  Skip
                </button>
                <span className="ml-auto text-meta text-fg-muted">{answeredCount} answered</span>
              </div>
            </form>
          )}

          {!question && (
            <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
              <p className="text-caption text-fg">
                {readyToSynthesise
                  ? 'Got it. I have enough to build your initial Brand DNA — and I can always learn more as you use Aura.'
                  : 'I do not have quite enough yet to build a useful profile. Answer a couple more questions when you have a moment.'}
              </p>
              {readyToSynthesise && (
                <button
                  type="button"
                  onClick={() => void build()}
                  disabled={building}
                  className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                >
                  {building ? 'Building…' : 'Build my Brand DNA'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {showProfile && profile && (
        <div className="flex-1 space-y-3 overflow-y-auto">
          <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
            <dl className="space-y-2">
              {FIELD_LABELS.filter(({ key }) => editing || profile[key]).map(({ key, label }) => (
                <div key={key}>
                  <dt className="text-meta font-medium text-fg-muted">{label}</dt>
                  {editing ? (
                    <textarea
                      defaultValue={(profile[key] as string | null) ?? ''}
                      onChange={(event) => setEdits((previous) => ({ ...previous, [key]: event.target.value }))}
                      rows={2}
                      className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-2 px-2 py-1 text-caption text-fg outline-none focus:border-accent"
                    />
                  ) : (
                    <dd className="text-caption text-fg">{profile[key] as string}</dd>
                  )}
                </div>
              ))}
            </dl>
          </div>

          <p className="text-meta text-fg-muted">
            Aura is now tuned to your business. This profile shapes your conversations, content and recommendations so
            they belong to your brand rather than reading as generic AI.
          </p>

          <div className="flex flex-wrap gap-2 pb-4">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => void saveEdits()}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                >
                  <Check size={14} aria-hidden />
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEdits({});
                  }}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg hover:bg-surface-2"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg hover:bg-surface-2"
              >
                <Pencil size={14} aria-hidden />
                Edit Brand DNA
              </button>
            )}
            <button
              type="button"
              onClick={() => void startOver()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg-muted hover:bg-surface-2 disabled:opacity-50"
            >
              <RotateCcw size={14} aria-hidden />
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
