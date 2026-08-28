import { type ReactNode, useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, ChevronDown, ChevronRight, Clock, KeyRound, Lock, LogOut, Monitor, Trash2, UserPlus, Users, Plus, X } from 'lucide-react';
import {
  api,
  mediaUrl,
  ApiError,
  BUSINESS_ROLES,
  type WhatsAppConnectionSnapshot,
  type AuthSessionDto,
  type MemberDto,
  type BusinessRole,
  type TeamDto,
  type AgentCapacityDto,
  type AgentAvailability,
  type TimeStatusResponse,
} from '../lib/api.js';
import { Avatar } from '../components/Avatar.js';
import { IntegrationSettingsPanel } from '../components/IntegrationSettingsPanel.js';
import { KnowledgeBaseCard } from '../components/KnowledgeBaseCard.js';
import { MediaLightbox } from '../components/MediaLightbox.js';
import { useTheme } from '../hooks/useTheme.js';
import { THEMES } from '../theme.js';
import { triggerLockNow } from '../lib/lockEvents.js';
import { DEFAULT_ARGON2_PARAMS, generateSalt, hashPin } from '../lib/pinCrypto.js';
import { useAuth } from '../hooks/useAuth.js';

const MAX_PROFILE_PICTURE_BYTES = 5 * 1024 * 1024;

// Real IANA zone list from the runtime's own tz database (Node/browser ICU) -
// never a hand-maintained list that can drift from what the server actually
// recognizes as valid.
const IANA_TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:<mime>;base64,<payload> - only the payload goes to the API.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const STATUS_COLOR: Record<WhatsAppConnectionSnapshot['status'], string> = {
  CONNECTED: 'bg-success/15 text-success',
  CONNECTING: 'bg-info/15 text-info',
  QR_READY: 'bg-info/15 text-info',
  RECONNECTING: 'bg-warning/15 text-warning',
  DISCONNECTED: 'bg-fg-muted/15 text-fg-muted',
  LOGGED_OUT: 'bg-error/15 text-error',
  ERROR: 'bg-error/15 text-error',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}


const SYNC_STATUS_LABEL: Record<TimeStatusResponse['timeContext']['syncStatus'], string> = {
  SYNCED: 'Internet synchronized',
  DEGRADED: 'Time synchronization degraded',
  STALE: 'Time synchronization stale',
  MANUAL_OVERRIDE: 'Manual time override active',
};

const SYNC_STATUS_COLOR: Record<TimeStatusResponse['timeContext']['syncStatus'], string> = {
  SYNCED: 'bg-success/15 text-success',
  DEGRADED: 'bg-warning/15 text-warning',
  STALE: 'bg-error/15 text-error',
  MANUAL_OVERRIDE: 'bg-info/15 text-info',
};

const COUNTRY_TIMEZONE: Record<string, string> = {
  BB: 'America/Barbados', TT: 'America/Port_of_Spain', JM: 'America/Jamaica',
  GY: 'America/Guyana', BS: 'America/Nassau', AG: 'America/Antigua',
  LC: 'America/St_Lucia', VC: 'America/St_Vincent', GD: 'America/Grenada',
  KN: 'America/St_Kitts', TC: 'America/Grand_Turk', KY: 'America/Cayman',
  VG: 'America/Tortola', AW: 'America/Aruba', US: 'America/New_York',
  GB: 'Europe/London', CA: 'America/Toronto', AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland', IN: 'Asia/Kolkata', NG: 'Africa/Lagos',
  GH: 'Africa/Accra', ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi',
};

/** Merged tile: personal country locale + business timezone + live synced time + manual override. */
function TimeLocationCard() {
  const [timeStatus, setTimeStatus] = useState<TimeStatusResponse | null>(null);
  const [country, setCountry] = useState('');
  const [timezone, setTimezone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overrideInput, setOverrideInput] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function loadTime() {
    try {
      const result = await api.getTimeStatus();
      setTimeStatus(result);
    } catch {
      /* silent — stale display is better than a spinner */
    }
  }

  useEffect(() => {
    void Promise.all([
      api.getBusiness().then((res) => setTimezone(res.business.timezone)).catch(() => undefined),
      api.getPreferences().then((res) => setCountry(res.preferences.country ?? '')).catch(() => undefined),
    ]);
    void loadTime();
    const interval = setInterval(() => void loadTime(), 30_000);
    return () => clearInterval(interval);
  }, []);

  function handleCountryChange(code: string) {
    setCountry(code);
    if (code && COUNTRY_TIMEZONE[code]) setTimezone(COUNTRY_TIMEZONE[code]);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!timezone.trim()) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await Promise.all([
        api.updatePreferences({ country: country || null }),
        api.updateBusinessTimezone(timezone.trim()),
      ]);
      setSaved(true);
      await loadTime();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEnableOverride() {
    if (!overrideInput) return;
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await api.enableManualTimeOverride(overrideInput);
      await loadTime();
    } catch (err) {
      setOverrideError(err instanceof ApiError ? err.message : 'Failed to enable manual override.');
    } finally {
      setOverrideBusy(false);
    }
  }

  async function handleDisableOverride() {
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await api.disableManualTimeOverride();
      await loadTime();
    } catch (err) {
      setOverrideError(err instanceof ApiError ? err.message : 'Failed to disable manual override.');
    } finally {
      setOverrideBusy(false);
    }
  }

  const tc = timeStatus?.timeContext;
  const isManual = tc?.syncStatus === 'MANUAL_OVERRIDE';

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-body font-semibold text-fg">
          <Clock size={15} aria-hidden />
          Time &amp; Location
        </h2>
        {tc && (
          <span className={`rounded-full px-2.5 py-1 text-caption font-medium ${SYNC_STATUS_COLOR[tc.syncStatus]}`}>
            {SYNC_STATUS_LABEL[tc.syncStatus]}
          </span>
        )}
      </div>

      {/* Live time */}
      {tc && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <p className="text-title font-semibold text-fg tabular-nums">
            {tc.dayOfWeek}, {tc.localDate} {tc.localDateTime.slice(11, 16)}
          </p>
          <p className="text-caption text-fg-muted">({tc.timezone}, UTC{tc.utcOffset})</p>
          {isManual && (
            <span className="rounded-full bg-info/15 px-2 py-0.5 text-meta font-semibold text-info">Override active</span>
          )}
        </div>
      )}

      {/* Country + Timezone pickers */}
      <form onSubmit={handleSave} className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-caption font-medium text-fg-secondary" htmlFor="tl-country">Country</label>
            <select
              id="tl-country"
              value={country}
              onChange={(e) => handleCountryChange(e.target.value)}
              className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
            >
              <option value="">— Not set —</option>
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>{name} ({code})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption font-medium text-fg-secondary" htmlFor="tl-timezone">Timezone</label>
            <input
              id="tl-timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="e.g. America/Barbados"
              list="tl-iana-zones"
              className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
            />
            <datalist id="tl-iana-zones">
              {IANA_TIMEZONES.map((zone) => <option key={zone} value={zone} />)}
            </datalist>
          </div>
        </div>
        <p className="text-meta text-fg-muted">
          Your country sets your locale preferences. The timezone tells your AI agents what "now" means — so they never
          claim to be open outside your real business hours.
        </p>
        {saveError && <p className="text-caption text-error">{saveError}</p>}
        {saved && <p className="text-caption text-success">Saved.</p>}
        <button
          type="submit"
          disabled={saving || !timezone.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      {/* Advanced collapsible */}
      <div className="mt-4 border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary hover:text-fg"
        >
          {showAdvanced ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          Advanced: Manual time override (testing only)
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-2">
            <p className="text-meta text-fg-muted">
              For testing only — sets what your AI agents see as "now" without changing anyone's real clock or timezone
              rules. Never settable from a WhatsApp conversation.
            </p>
            {overrideError && <p className="text-caption text-error">{overrideError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                value={overrideInput}
                onChange={(e) => setOverrideInput(e.target.value)}
                className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void handleEnableOverride()}
                disabled={overrideBusy || !overrideInput}
                className="rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
              >
                {overrideBusy ? 'Saving…' : 'Set override'}
              </button>
              {isManual && (
                <button
                  type="button"
                  onClick={() => void handleDisableOverride()}
                  disabled={overrideBusy}
                  className="rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                >
                  Clear override
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Profile card (Business + WhatsApp merged) ───────────────────────────────

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
type DayName = (typeof DAYS)[number];
const DAY_SHORT: Record<DayName, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};
interface DayHours { open: boolean; from: string; to: string; }
type WeekHours = Record<DayName, DayHours>;

function defaultHours(): WeekHours {
  return Object.fromEntries(DAYS.map((d, i) => [d, { open: i < 5, from: '09:00', to: '17:00' }])) as WeekHours;
}

const PROFILE_KB_TITLE = 'Business Profile';

function buildProfileContent(s: string, m: string, addr: string, ph: string, em: string, web: string, hours: WeekHours): string {
  const lines: string[] = ['[Auto-generated from business profile settings]\n'];
  if (s) lines.push(`Slogan: ${s}`);
  if (m) lines.push(`Motto: ${m}`);
  if (addr) lines.push(`Address: ${addr}`);
  if (ph) lines.push(`Alt Phone: ${ph}`);
  if (em) lines.push(`Alt Email: ${em}`);
  if (web) lines.push(`Website: ${web}`);
  lines.push('\nOpening Hours:');
  for (const day of DAYS) {
    const h = hours[day];
    lines.push(`  ${day}: ${h.open ? `${h.from}–${h.to}` : 'Closed'}`);
  }
  return lines.join('\n');
}

function parseProfileContent(content: string): { slogan: string; motto: string; address: string; altPhone: string; altEmail: string; website: string; hours: WeekHours } {
  const get = (key: string) => content.match(new RegExp(`^${key}: (.+)`, 'mi'))?.[1]?.trim() ?? '';
  const hours = defaultHours();
  for (const day of DAYS) {
    const match = content.match(new RegExp(`  ${day}: (.+)`, 'i'));
    if (match) {
      const val = match[1].trim();
      if (val.toLowerCase() === 'closed') {
        hours[day] = { open: false, from: '09:00', to: '17:00' };
      } else {
        const [from, to] = val.split('–');
        if (from && to) hours[day] = { open: true, from: from.trim(), to: to.trim() };
      }
    }
  }
  return { slogan: get('Slogan'), motto: get('Motto'), address: get('Address'), altPhone: get('Alt Phone'), altEmail: get('Alt Email'), website: get('Website'), hours };
}

function ProfileCard({ connection }: { connection: WhatsAppConnectionSnapshot | null }) {
  // Business name
  const [bizName, setBizName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Rich profile (saved as KB doc)
  const [profileDocId, setProfileDocId] = useState<string | null>(null);
  const [slogan, setSlogan] = useState('');
  const [motto, setMotto] = useState('');
  const [address, setAddress] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [altEmail, setAltEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [hours, setHours] = useState<WeekHours>(defaultHours);
  const [showDetails, setShowDetails] = useState(false);
  const [showHours, setShowHours] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // WA photo
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WA actions
  const [waBusy, setWaBusy] = useState<'disconnect' | 'logout' | null>(null);
  const [waError, setWaError] = useState<string | null>(null);

  useEffect(() => {
    api.getBusiness().then((res) => setBizName(res.business.name)).catch(() => undefined);
    api.listKnowledgeBaseDocuments().then((res) => {
      const doc = res.documents.find((d) => d.title === PROFILE_KB_TITLE);
      if (doc) {
        setProfileDocId(doc.id);
        const parsed = parseProfileContent(doc.content);
        setSlogan(parsed.slogan); setMotto(parsed.motto); setAddress(parsed.address);
        setAltPhone(parsed.altPhone); setAltEmail(parsed.altEmail); setWebsite(parsed.website);
        setHours(parsed.hours);
      }
    }).catch(() => undefined);
  }, []);

  async function handleSaveName() {
    if (!bizName.trim()) return;
    setSavingName(true); setNameError(null);
    try { await api.updateBusiness(bizName.trim()); setEditingName(false); }
    catch (err) { setNameError(err instanceof ApiError ? err.message : 'Failed to save.'); }
    finally { setSavingName(false); }
  }

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true); setProfileSaved(false); setProfileError(null);
    const content = buildProfileContent(slogan, motto, address, altPhone, altEmail, website, hours);
    try {
      if (profileDocId) {
        await api.updateKnowledgeBaseDocument(profileDocId, PROFILE_KB_TITLE, content);
      } else {
        const res = await api.createKnowledgeBaseDocument(PROFILE_KB_TITLE, content);
        setProfileDocId(res.document.id);
      }
      setProfileSaved(true);
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'Failed to save profile.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePhotoSelected(file: File) {
    if (!file.type.startsWith('image/')) { setWaError('Please choose an image file.'); return; }
    if (file.size > MAX_PROFILE_PICTURE_BYTES) { setWaError('Image is too large (max 5 MB).'); return; }
    setWaError(null); setUploadingPhoto(true);
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    try { await api.updateAccountProfilePicture(await fileToBase64(file), file.type); }
    catch (err) { setWaError(err instanceof ApiError ? err.message : 'Failed to update profile photo.'); setPreviewUrl(null); URL.revokeObjectURL(objectUrl); }
    finally { setUploadingPhoto(false); }
  }

  async function handleDisconnect() {
    setWaBusy('disconnect'); setWaError(null);
    try { await api.disconnectWhatsApp(); }
    catch (err) { setWaError(err instanceof Error ? err.message : 'Failed to disconnect.'); }
    finally { setWaBusy(null); }
  }

  async function handleLogout() {
    if (!window.confirm('Log out of WhatsApp? You will need to re-scan a QR code to reconnect.')) return;
    setWaBusy('logout'); setWaError(null);
    try { await api.logoutWhatsApp(); }
    catch (err) { setWaError(err instanceof Error ? err.message : 'Failed to log out.'); }
    finally { setWaBusy(null); }
  }

  const currentPhotoUrl = previewUrl ?? (connection?.avatarMediaId ? mediaUrl(connection.avatarMediaId) : null);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      {/* Identity row */}
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <button type="button" onClick={() => currentPhotoUrl && setLightboxOpen(true)} disabled={!currentPhotoUrl} className="block disabled:cursor-default">
            <Avatar label={(connection?.pushName ?? bizName) || '?'} photoUrl={currentPhotoUrl} />
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingPhoto} title="Change WhatsApp profile photo"
            className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-surface-1 bg-accent text-white shadow hover:bg-accent-dim disabled:opacity-50">
            <Camera size={11} aria-hidden />
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handlePhotoSelected(f); }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editingName ? (
              <input value={bizName} onChange={(e) => setBizName(e.target.value)} autoFocus
                className="flex-1 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-body font-medium text-fg outline-none focus:border-accent" />
            ) : (
              <p className="truncate text-body font-semibold text-fg">{bizName || '—'}</p>
            )}
            {!editingName
              ? <button type="button" onClick={() => setEditingName(true)} className="text-fg-muted hover:text-fg"><ChevronRight size={13} aria-hidden /></button>
              : <button type="button" onClick={() => void handleSaveName()} disabled={savingName || !bizName.trim()}
                  className="rounded-md bg-accent px-2 py-0.5 text-meta font-medium text-white hover:bg-accent-dim disabled:opacity-50">
                  {savingName ? '…' : 'Save'}
                </button>
            }
            {editingName && (
              <button type="button" onClick={() => setEditingName(false)} className="text-meta text-fg-muted hover:text-fg">Cancel</button>
            )}
          </div>
          {nameError && <p className="text-meta text-error">{nameError}</p>}
          <p className="truncate text-caption text-fg-muted">
            {connection?.phoneNumber ?? 'WhatsApp not connected'}
            {connection?.connectedAt ? ` · Connected ${formatDate(connection.connectedAt)}` : ''}
          </p>
        </div>
        {connection && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${STATUS_COLOR[connection.status]}`}>
            {connection.status.replace('_', ' ')}
          </span>
        )}
      </div>

      {lightboxOpen && currentPhotoUrl && <MediaLightbox imageUrl={currentPhotoUrl} fileName={null} onClose={() => setLightboxOpen(false)} />}
      {uploadingPhoto && <p className="mt-1 text-meta text-fg-muted">Updating on WhatsApp…</p>}

      {/* WA connection actions */}
      {connection && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {waError && <p className="w-full text-caption text-error">{waError}</p>}
          {connection.lastError && <p className="w-full text-caption text-error">{connection.lastError}</p>}
          <button type="button" onClick={() => void handleDisconnect()}
            disabled={waBusy !== null || connection.status === 'DISCONNECTED' || connection.status === 'LOGGED_OUT'}
            title="Keeps your session - reconnect without re-scanning"
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-meta font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50">
            {waBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
          <button type="button" onClick={() => void handleLogout()} disabled={waBusy !== null}
            title="Ends the session - you'll need to scan a new QR code"
            className="rounded-lg border border-error/30 px-3 py-1.5 text-meta font-medium text-error hover:bg-error/10 disabled:opacity-50">
            {waBusy === 'logout' ? 'Logging out…' : 'Log out of WhatsApp'}
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
        {/* Business details accordion */}
        <button type="button" onClick={() => setShowDetails((v) => !v)}
          className="flex w-full items-center justify-between text-caption font-medium text-fg-secondary hover:text-fg">
          <span className="flex items-center gap-1.5">
            {showDetails ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Business details
          </span>
          <span className="text-meta text-fg-muted">AI-visible · saved to knowledge base</span>
        </button>

        {showDetails && (
          <form onSubmit={handleSaveProfile} className="space-y-2 pl-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="text-meta font-medium text-fg-muted">Slogan</label>
                <input value={slogan} onChange={(e) => setSlogan(e.target.value)} placeholder="Your tagline"
                  className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-meta font-medium text-fg-muted">Motto</label>
                <input value={motto} onChange={(e) => setMotto(e.target.value)} placeholder="Internal guiding phrase"
                  className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
              </div>
            </div>
            <div>
              <label className="text-meta font-medium text-fg-muted">Business address</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, country"
                className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="text-meta font-medium text-fg-muted">Alt phone</label>
                <input value={altPhone} onChange={(e) => setAltPhone(e.target.value)} placeholder="+1 246 …"
                  className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-meta font-medium text-fg-muted">Alt email</label>
                <input type="email" value={altEmail} onChange={(e) => setAltEmail(e.target.value)} placeholder="info@…"
                  className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-meta font-medium text-fg-muted">Website</label>
                <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…"
                  className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent" />
              </div>
            </div>
            {profileError && <p className="text-meta text-error">{profileError}</p>}
            {profileSaved && <p className="text-meta text-success">Saved to knowledge base.</p>}
            <button type="submit" disabled={savingProfile}
              className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
              {savingProfile ? 'Saving…' : 'Save details'}
            </button>
          </form>
        )}

        {/* Opening hours accordion */}
        <button type="button" onClick={() => setShowHours((v) => !v)}
          className="flex w-full items-center justify-between text-caption font-medium text-fg-secondary hover:text-fg">
          <span className="flex items-center gap-1.5">
            {showHours ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Opening hours
          </span>
          <span className="text-meta text-fg-muted">AI-visible · saved with business details</span>
        </button>

        {showHours && (
          <form onSubmit={handleSaveProfile} className="pl-4">
            <div className="grid grid-cols-1 gap-y-1.5 sm:grid-cols-2">
              {DAYS.map((day) => {
                const h = hours[day];
                return (
                  <div key={day} className="flex items-center gap-2">
                    <input type="checkbox" id={`h-${day}`} checked={h.open}
                      onChange={(e) => setHours((prev) => ({ ...prev, [day]: { ...prev[day], open: e.target.checked } }))}
                      className="h-3.5 w-3.5 accent-accent" />
                    <label htmlFor={`h-${day}`} className="w-8 text-meta font-medium text-fg-secondary">{DAY_SHORT[day]}</label>
                    {h.open ? (
                      <>
                        <input type="time" value={h.from}
                          onChange={(e) => setHours((prev) => ({ ...prev, [day]: { ...prev[day], from: e.target.value } }))}
                          className="rounded border border-border-subtle bg-surface-1 px-1.5 py-0.5 text-meta text-fg outline-none focus:border-accent" />
                        <span className="text-meta text-fg-muted">–</span>
                        <input type="time" value={h.to}
                          onChange={(e) => setHours((prev) => ({ ...prev, [day]: { ...prev[day], to: e.target.value } }))}
                          className="rounded border border-border-subtle bg-surface-1 px-1.5 py-0.5 text-meta text-fg outline-none focus:border-accent" />
                      </>
                    ) : (
                      <span className="text-meta text-fg-muted">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
            {profileError && <p className="mt-2 text-meta text-error">{profileError}</p>}
            {profileSaved && <p className="mt-2 text-meta text-success">Saved to knowledge base.</p>}
            <button type="submit" disabled={savingProfile}
              className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
              {savingProfile ? 'Saving…' : 'Save hours'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function SecurityCard() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showChange, setShowChange] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeOk, setChangeOk] = useState(false);

  useEffect(() => {
    api
      .getLockStatus()
      .then((status) => setConfigured(status.configured))
      .catch(() => setConfigured(null));
  }, []);

  async function handleChangePin(e: FormEvent) {
    e.preventDefault();
    if (newPin !== confirmPin) {
      setChangeError('New PINs do not match.');
      return;
    }
    setChangeBusy(true);
    setChangeError(null);
    try {
      const challenge = await api.getUnlockChallenge();
      const currentPinHash = await hashPin(currentPin, challenge.salt, challenge.argon2Params);
      const newSalt = generateSalt();
      const newPinHash = await hashPin(newPin, newSalt);
      await api.changeLockPin({ currentPinHash, newSalt, newPinHash, newArgon2Params: DEFAULT_ARGON2_PARAMS });
      setChangeOk(true);
      setShowChange(false);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WRONG_CURRENT_PIN') {
        setChangeError('Current PIN is incorrect.');
      } else {
        setChangeError('Failed to change PIN. Please try again.');
      }
    } finally {
      setChangeBusy(false);
    }
  }

  function cancelChange() {
    setShowChange(false);
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setChangeError(null);
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-body font-semibold text-fg">Screen lock</h2>
      <p className="mt-1 text-caption text-fg-muted">
        {configured
          ? 'A PIN is set - the app locks automatically after 5 minutes idle, or press Alt+L any time. Live messaging, AI replies, and the CRM keep running while locked.'
          : 'No PIN set up yet. Press "Lock now" (or Alt+L) to set one.'}
      </p>
      {changeOk && <p className="mt-2 text-caption text-green-600">PIN changed successfully.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => triggerLockNow()}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3"
        >
          <Lock size={13} aria-hidden />
          {configured ? 'Lock now' : 'Set up a PIN'}
        </button>
        {configured && !showChange && (
          <button
            type="button"
            onClick={() => { setShowChange(true); setChangeOk(false); }}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3"
          >
            <KeyRound size={13} aria-hidden />
            Change PIN
          </button>
        )}
      </div>
      {showChange && (
        <form onSubmit={handleChangePin} className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-caption font-medium text-fg-secondary" htmlFor="current-pin">Current PIN</label>
            <input
              id="current-pin"
              type="password"
              inputMode="numeric"
              minLength={6}
              maxLength={8}
              required
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value)}
              placeholder="6–8 digits"
              className="block w-full rounded-lg border border-border-subtle bg-surface-3 px-3 py-1.5 text-caption text-fg placeholder-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption font-medium text-fg-secondary" htmlFor="new-pin">New PIN</label>
            <input
              id="new-pin"
              type="password"
              inputMode="numeric"
              minLength={6}
              maxLength={8}
              required
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              placeholder="6–8 digits"
              className="block w-full rounded-lg border border-border-subtle bg-surface-3 px-3 py-1.5 text-caption text-fg placeholder-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption font-medium text-fg-secondary" htmlFor="confirm-pin">Confirm new PIN</label>
            <input
              id="confirm-pin"
              type="password"
              inputMode="numeric"
              minLength={6}
              maxLength={8}
              required
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              placeholder="Repeat new PIN"
              className="block w-full rounded-lg border border-border-subtle bg-surface-3 px-3 py-1.5 text-caption text-fg placeholder-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          {changeError && <p className="text-caption text-red-500">{changeError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={changeBusy}
              className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {changeBusy ? 'Changing…' : 'Change PIN'}
            </button>
            <button
              type="button"
              onClick={cancelChange}
              className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Representative (background, accent) swatch pair per theme - matches index.css's [data-theme] token overrides exactly. */
const THEME_SWATCHES: Record<string, [string, string]> = {
  sleek: ['#f0f2f5', '#4f46e5'],
  dark: ['#0c1317', '#00a884'],
  light: ['#d1d7db', '#00a884'],
  midnight: ['#000000', '#238636'],
  forest: ['#0a1612', '#2ec4b6'],
  sunset: ['#140c1a', '#d946ef'],
};

function ThemeCard() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-body font-semibold text-fg">Theme</h2>
      <p className="mt-1 text-caption text-fg-muted">Saved to this browser - applies instantly, everywhere in the app.</p>
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {THEMES.map((option) => {
          const [bg, accent] = THEME_SWATCHES[option.id] ?? ['#000000', '#000000'];
          const selected = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setTheme(option.id)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                selected ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:bg-surface-3'
              }`}
            >
              <span
                className="h-7 w-7 shrink-0 rounded-full border border-border-subtle"
                style={{ background: `conic-gradient(${accent} 0deg 180deg, ${bg} 180deg 360deg)` }}
                aria-hidden
              />
              <span className={`text-caption font-medium ${selected ? 'text-accent' : 'text-fg-secondary'}`}>{option.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccountCard() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-body font-semibold text-fg">Account</h2>
      <p className="mt-1 text-caption text-fg-muted">
        Signed in as <span className="text-fg-secondary">{auth.user?.email}</span>
        {auth.role && <> · <span className="text-fg-secondary">{auth.role}</span></>}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await auth.logout();
        }}
        className="mt-3 flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
      >
        <LogOut size={13} aria-hidden />
        Sign out
      </button>
    </div>
  );
}

function formatSessionTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function SessionsCard() {
  const [sessions, setSessions] = useState<AuthSessionDto[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const result = await api.listSessions();
      setSessions(result.sessions);
    } catch {
      setError('Could not load your sessions.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleRevoke(id: string) {
    setBusyId(id);
    try {
      await api.revokeSession(id);
      await load();
    } catch {
      setError('Could not sign out that device.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevokeOthers() {
    setBusyId('others');
    try {
      await api.revokeOtherSessions();
      await load();
    } catch {
      setError('Could not sign out other devices.');
    } finally {
      setBusyId(null);
    }
  }

  const hasOtherSessions = (sessions ?? []).some((session) => !session.isCurrent);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-body font-semibold text-fg">Sessions</h2>
        {hasOtherSessions && (
          <button
            type="button"
            disabled={busyId === 'others'}
            onClick={handleRevokeOthers}
            className="text-caption font-medium text-fg-secondary hover:text-fg disabled:opacity-50"
          >
            Sign out all other sessions
          </button>
        )}
      </div>
      <p className="mt-1 text-caption text-fg-muted">Devices currently signed in to your account.</p>
      {error && <p className="mt-2 text-caption text-error">{error}</p>}

      <div className="mt-3 space-y-2">
        {sessions === null && <p className="text-caption text-fg-muted">Loading…</p>}
        {sessions?.length === 0 && <p className="text-caption text-fg-muted">No active sessions.</p>}
        {sessions?.map((session) => (
          <div key={session.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <Monitor size={15} className="shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-caption font-medium text-fg">
                  {session.browser} on {session.os}
                  {session.isCurrent && <span className="ml-1.5 rounded-full bg-success/15 px-1.5 py-0.5 text-meta font-semibold text-success">Current device</span>}
                </p>
                <p className="truncate text-meta text-fg-muted">
                  Last active {formatSessionTimestamp(session.lastSeenAt)}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                </p>
              </div>
            </div>
            {!session.isCurrent && (
              <button
                type="button"
                disabled={busyId === session.id}
                onClick={() => handleRevoke(session.id)}
                className="shrink-0 text-caption font-medium text-error hover:underline disabled:opacity-50"
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const ASSIGNABLE_ROLES = BUSINESS_ROLES.filter((role) => role !== 'OWNER');

function TeamMembersCard() {
  const auth = useAuth();
  const canManage = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<BusinessRole>('AGENT');
  const [busy, setBusy] = useState(false);
  const [createdCredential, setCreatedCredential] = useState<{ email: string; temporaryPassword: string } | null>(null);

  async function load() {
    try {
      const result = await api.listMembers();
      setMembers(result.members);
    } catch {
      setError('Could not load team members.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createMember({ email, displayName, role });
      setCreatedCredential({ email: result.member.email, temporaryPassword: result.temporaryPassword });
      setEmail('');
      setDisplayName('');
      setRole('AGENT');
      setShowAddForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that team member.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(membershipId: string, nextRole: BusinessRole) {
    try {
      await api.updateMemberRole(membershipId, nextRole);
      await load();
    } catch {
      setError('Could not update that member’s role.');
    }
  }

  async function handleRemove(membershipId: string) {
    try {
      await api.removeMember(membershipId);
      await load();
    } catch {
      setError('Could not remove that member.');
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-body font-semibold text-fg">Team</h2>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowAddForm((value) => !value)}
            className="flex items-center gap-1.5 text-caption font-medium text-accent hover:text-accent-dim"
          >
            <UserPlus size={13} aria-hidden />
            Add member
          </button>
        )}
      </div>
      <p className="mt-1 text-caption text-fg-muted">
        No email delivery is configured yet - adding a member creates a one-time password shown here once for you to share with them directly.
      </p>

      {error && <p className="mt-2 text-caption text-error">{error}</p>}

      {createdCredential && (
        <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-3 text-caption text-fg">
          <p className="font-medium">Account created for {createdCredential.email}</p>
          <p className="mt-1">
            Temporary password: <code className="rounded bg-surface-1 px-1.5 py-0.5 font-mono">{createdCredential.temporaryPassword}</code>
          </p>
          <p className="mt-1 text-fg-muted">Share this with them now - it won&apos;t be shown again.</p>
          <button type="button" onClick={() => setCreatedCredential(null)} className="mt-2 text-fg-muted hover:text-fg">
            Dismiss
          </button>
        </div>
      )}

      {showAddForm && canManage && (
        <form onSubmit={handleCreate} className="mt-3 flex flex-col gap-2 rounded-lg border border-border-subtle p-3">
          <input
            type="text"
            required
            placeholder="Full name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
          />
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as BusinessRole)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
          >
            {ASSIGNABLE_ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add member'}
          </button>
        </form>
      )}

      <div className="mt-3 space-y-2">
        {members === null && <p className="text-caption text-fg-muted">Loading…</p>}
        {members?.map((member) => (
          <div key={member.membershipId} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-caption font-medium text-fg">{member.displayName}</p>
              <p className="truncate text-meta text-fg-muted">{member.email}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canManage && member.role !== 'OWNER' ? (
                <select
                  value={member.role}
                  onChange={(event) => handleRoleChange(member.membershipId, event.target.value as BusinessRole)}
                  className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-meta text-fg outline-none focus:border-accent"
                >
                  {ASSIGNABLE_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-meta font-medium text-fg-secondary">{member.role}</span>
              )}
              {canManage && member.role !== 'OWNER' && (
                <button
                  type="button"
                  onClick={() => handleRemove(member.membershipId)}
                  aria-label={`Remove ${member.displayName}`}
                  className="text-fg-muted hover:text-error"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamCard({ team, members, onChanged }: { team: TeamDto; members: MemberDto[]; onChanged: () => void }) {
  const auth = useAuth();
  const canManage = auth.role === 'OWNER' || auth.role === 'ADMIN' || auth.role === 'MANAGER' || auth.role === 'SUPERVISOR';
  const [addingMember, setAddingMember] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const memberIds = new Set(team.members.map((m) => m.userId));
  const addableMembers = members.filter((m) => !memberIds.has(m.userId));

  async function handleAddMember(event: FormEvent) {
    event.preventDefault();
    if (!selectedUserId) return;
    setBusy(true);
    try {
      await api.addTeamMember(team.id, selectedUserId);
      setSelectedUserId('');
      setAddingMember(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(userId: string) {
    setBusy(true);
    try {
      await api.removeTeamMember(team.id, userId);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTeam() {
    setBusy(true);
    try {
      await api.deleteTeam(team.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-caption font-semibold text-fg">{team.name}</p>
          {team.description && <p className="text-meta text-fg-muted">{team.description}</p>}
        </div>
        {canManage && (
          <button type="button" onClick={handleDeleteTeam} disabled={busy} className="text-fg-muted hover:text-error">
            <Trash2 size={13} aria-hidden />
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {team.members.map((member) => (
          <span key={member.userId} className="flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-meta text-fg-secondary">
            {member.displayName}
            {canManage && (
              <button type="button" onClick={() => handleRemoveMember(member.userId)} aria-label={`Remove ${member.displayName}`}>
                <X size={11} aria-hidden className="text-fg-muted hover:text-error" />
              </button>
            )}
          </span>
        ))}
        {team.members.length === 0 && <span className="text-meta text-fg-muted">No members yet.</span>}
      </div>

      {canManage && (
        <div className="mt-2">
          {addingMember ? (
            <form onSubmit={handleAddMember} className="flex items-center gap-1.5">
              <select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-meta text-fg outline-none focus:border-accent"
              >
                <option value="">Select a member…</option>
                {addableMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={busy || !selectedUserId} className="text-meta font-medium text-accent hover:text-accent-dim disabled:opacity-50">
                Add
              </button>
              <button type="button" onClick={() => setAddingMember(false)} className="text-meta text-fg-muted hover:text-fg">
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" onClick={() => setAddingMember(true)} className="flex items-center gap-1 text-meta font-medium text-accent hover:text-accent-dim">
              <Plus size={11} aria-hidden />
              Add member
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TeamsCard() {
  const auth = useAuth();
  const canCreate = auth.role === 'OWNER' || auth.role === 'ADMIN' || auth.role === 'MANAGER' || auth.role === 'SUPERVISOR';
  const [teams, setTeams] = useState<TeamDto[] | null>(null);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [teamsResult, membersResult] = await Promise.all([api.listTeams(), api.listMembers()]);
      setTeams(teamsResult.teams);
      setMembers(membersResult.members);
    } catch {
      setError('Could not load teams.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTeam(name.trim(), null);
      setName('');
      setShowCreateForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that team.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-body font-semibold text-fg">Teams</h2>
        {canCreate && (
          <button type="button" onClick={() => setShowCreateForm((v) => !v)} className="flex items-center gap-1.5 text-caption font-medium text-accent hover:text-accent-dim">
            <Users size={13} aria-hidden />
            New team
          </button>
        )}
      </div>
      <p className="mt-1 text-caption text-fg-muted">Group teammates (Sales, Support, …) and assign conversations to a team.</p>

      {error && <p className="mt-2 text-caption text-error">{error}</p>}

      {showCreateForm && canCreate && (
        <form onSubmit={handleCreate} className="mt-3 flex items-center gap-1.5">
          <input
            type="text"
            required
            placeholder="Team name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
          />
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
            Create
          </button>
        </form>
      )}

      <div className="mt-3 space-y-2">
        {teams === null && <p className="text-caption text-fg-muted">Loading…</p>}
        {teams?.length === 0 && <p className="text-caption text-fg-muted">No teams yet.</p>}
        {teams?.map((team) => (
          <TeamCard key={team.id} team={team} members={members} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

const AVAILABILITY_LABEL: Record<AgentAvailability, string> = { available: 'Available', busy: 'Busy', offline: 'Offline' };
const AVAILABILITY_COLOR: Record<AgentAvailability, string> = {
  available: 'bg-success/15 text-success',
  busy: 'bg-warning/15 text-warning',
  offline: 'bg-fg-muted/15 text-fg-muted',
};

function AvailabilityCard() {
  const [capacity, setCapacity] = useState<AgentCapacityDto | null>(null);
  const [maxInput, setMaxInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getMyCapacity()
      .then((result) => {
        setCapacity(result.capacity);
        setMaxInput(String(result.capacity.maxActiveConversations));
      })
      .catch(() => undefined);
  }, []);

  async function handleAvailabilityChange(availability: AgentAvailability) {
    setBusy(true);
    try {
      const result = await api.updateMyCapacity({ availability });
      setCapacity(result.capacity);
    } finally {
      setBusy(false);
    }
  }

  async function handleMaxSave() {
    const parsed = Number(maxInput);
    if (!Number.isFinite(parsed) || parsed < 1) return;
    setBusy(true);
    try {
      const result = await api.updateMyCapacity({ maxActiveConversations: Math.round(parsed) });
      setCapacity(result.capacity);
    } finally {
      setBusy(false);
    }
  }

  if (!capacity) return null;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-body font-semibold text-fg">Availability</h2>
      <p className="mt-1 text-caption text-fg-muted">Controls whether conversations can be assigned to you, and how many at once.</p>

      <div className="mt-3 flex gap-1.5">
        {(['available', 'busy', 'offline'] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy}
            onClick={() => handleAvailabilityChange(option)}
            className={`rounded-full px-3 py-1 text-caption font-medium transition ${
              capacity.availability === option ? AVAILABILITY_COLOR[option] : 'bg-surface-3 text-fg-muted hover:text-fg-secondary'
            }`}
          >
            {AVAILABILITY_LABEL[option]}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <label className="text-caption text-fg-secondary">Max active conversations</label>
        <input
          type="number"
          min={1}
          max={1000}
          value={maxInput}
          onChange={(event) => setMaxInput(event.target.value)}
          onBlur={handleMaxSave}
          className="w-20 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-caption text-fg outline-none focus:border-accent"
        />
      </div>
    </div>
  );
}

const COUNTRIES: [string, string][] = [
  ['BB', 'Barbados'], ['TT', 'Trinidad & Tobago'], ['JM', 'Jamaica'], ['GY', 'Guyana'], ['BS', 'Bahamas'],
  ['AG', 'Antigua & Barbuda'], ['LC', 'Saint Lucia'], ['VC', 'Saint Vincent'], ['GD', 'Grenada'], ['KN', 'Saint Kitts & Nevis'],
  ['TC', 'Turks & Caicos'], ['KY', 'Cayman Islands'], ['VG', 'British Virgin Islands'], ['AW', 'Aruba'],
  ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'], ['NZ', 'New Zealand'],
  ['IN', 'India'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['ZA', 'South Africa'], ['KE', 'Kenya'],
];


function SettingsSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <p className="shrink-0 text-meta font-semibold uppercase tracking-widest text-fg-muted">{label}</p>
        <div className="h-px flex-1 bg-border-subtle" />
      </div>
      {children}
    </div>
  );
}

export function SettingsRoute({ connection }: { connection: WhatsAppConnectionSnapshot | null }) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-title font-semibold text-fg">Settings</h1>
      <p className="mt-1 text-body text-fg-muted">Configure your workspace, business profile, and account.</p>

      <div className="mt-6 max-w-5xl space-y-8">

        {/* ── Appearance ── */}
        <SettingsSection label="Appearance">
          <ThemeCard />
        </SettingsSection>

        {/* ── Business ── */}
        <SettingsSection label="Business">
          <div className="space-y-3">
            <ProfileCard connection={connection} />
            <TimeLocationCard />
          </div>
        </SettingsSection>

        {/* ── AI & Knowledge ── */}
        <SettingsSection label="AI & Knowledge">
          <div className="space-y-3">
            <KnowledgeBaseCard />
            <IntegrationSettingsPanel />
          </div>
        </SettingsSection>

        {/* ── Team ── */}
        <SettingsSection label="Team">
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <TeamMembersCard />
              <TeamsCard />
            </div>
            <AvailabilityCard />
          </div>
        </SettingsSection>

        {/* ── Account & Security ── */}
        <SettingsSection label="Account & Security">
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <AccountCard />
              <SecurityCard />
            </div>
            <SessionsCard />
          </div>
        </SettingsSection>

      </div>
    </div>
  );
}
