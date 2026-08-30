import { type ComponentType, type ReactNode, useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Building2, Camera, ChevronDown, ChevronRight, Clipboard, Clock, KeyRound, Lock, LogOut, Mail, Monitor, Palette, PanelLeft, PanelLeftClose, RefreshCw, ShieldCheck, Trash2, UserPlus, Users, Plus, X } from 'lucide-react';
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
import { LOCK_TIMEOUT_KEY } from '../components/ScreenLock.js';
import { ALERT_POSITION_KEY, ALERT_SCALE_KEY, ALERT_SCALE_MIN, ALERT_SCALE_MAX, type AlertBannerPosition } from '../components/AlertNotifier.js';
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
  CONFLICT_REPLACED: 'bg-error/15 text-error',
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
      const val = (match[1] ?? '').trim();
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

const LOCK_TIMEOUT_OPTIONS = [
  { value: '1', label: '1 minute' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
];

function getLockTimeoutValue(): string {
  try { return localStorage.getItem(LOCK_TIMEOUT_KEY) ?? '5'; } catch { return '5'; }
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
  const [lockTimeout, setLockTimeout] = useState(getLockTimeoutValue);

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
          ? 'A PIN is set — the app locks after the selected idle time, or press Alt+L any time. Live messaging, AI replies, and the CRM keep running while locked.'
          : 'No PIN set up yet. Press "Lock now" (or Alt+L) to set one.'}
      </p>
      {configured && (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-caption font-medium text-fg-secondary" htmlFor="lock-timeout">
            Lock after idle for
          </label>
          <select
            id="lock-timeout"
            value={lockTimeout}
            onChange={(e) => {
              const v = e.target.value;
              setLockTimeout(v);
              try { localStorage.setItem(LOCK_TIMEOUT_KEY, v); } catch {}
              window.dispatchEvent(new StorageEvent('storage', { key: LOCK_TIMEOUT_KEY, newValue: v }));
            }}
            className="rounded-lg border border-border-subtle bg-surface-3 px-2 py-1 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {LOCK_TIMEOUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
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

function getAlertPositionSetting(): AlertBannerPosition {
  try {
    const v = localStorage.getItem(ALERT_POSITION_KEY);
    if (v === 'left' || v === 'right') return v;
  } catch {}
  return 'right';
}

function getAlertScaleSetting(): number {
  try {
    const n = parseFloat(localStorage.getItem(ALERT_SCALE_KEY) ?? '');
    if (!isNaN(n) && n >= ALERT_SCALE_MIN && n <= ALERT_SCALE_MAX) return n;
  } catch {}
  return 1;
}

/**
 * Controls where the pulsing "Urgent Lead Handover" banners sit and how big
 * they render - including on the lock screen, where they render above the
 * PIN prompt by design (background handoffs must stay visible even while
 * locked). Saved to this browser via the same localStorage + 'storage'
 * event pattern as the lock-timeout setting above, so AlertNotifier picks
 * up a change live, with no reload.
 */
function AlertBannerCard() {
  const [position, setPosition] = useState<AlertBannerPosition>(getAlertPositionSetting);
  const [scale, setScale] = useState<number>(getAlertScaleSetting);

  function updatePosition(next: AlertBannerPosition) {
    setPosition(next);
    try { localStorage.setItem(ALERT_POSITION_KEY, next); } catch {}
    window.dispatchEvent(new StorageEvent('storage', { key: ALERT_POSITION_KEY, newValue: next }));
  }

  function updateScale(next: number) {
    setScale(next);
    try { localStorage.setItem(ALERT_SCALE_KEY, String(next)); } catch {}
    window.dispatchEvent(new StorageEvent('storage', { key: ALERT_SCALE_KEY, newValue: String(next) }));
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-body font-semibold text-fg">Alerts</h2>
      <p className="mt-1 text-caption text-fg-muted">
        Where the urgent lead-handover banners sit and how big they render - including on the lock screen, where they always stay visible.
      </p>

      <div className="mt-4 space-y-1">
        <label className="text-caption font-medium text-fg-secondary">Position</label>
        <div className="inline-flex rounded-lg border border-border-subtle p-0.5">
          {(['left', 'right'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => updatePosition(option)}
              className={`rounded-md px-3 py-1 text-caption font-medium capitalize transition ${
                position === option ? 'bg-accent text-white' : 'text-fg-secondary hover:bg-surface-3'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-caption font-medium text-fg-secondary" htmlFor="alert-scale">Size</label>
          <span className="text-caption text-fg-muted">{Math.round(scale * 100)}%</span>
        </div>
        <input
          id="alert-scale"
          type="range"
          min={ALERT_SCALE_MIN}
          max={ALERT_SCALE_MAX}
          step={0.05}
          value={scale}
          onChange={(e) => updateScale(parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
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


type SettingsView = 'business' | 'ai' | 'appearance' | 'team' | 'account' | 'inbox';

const SETTINGS_NAV: { id: SettingsView; label: string; sub: string; Icon: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }> }[] = [
  { id: 'business',   label: 'Business',           sub: 'Profile · Time & location',       Icon: Building2   },
  { id: 'ai',         label: 'AI & Knowledge',      sub: 'Knowledge base · Integrations',   Icon: Bot         },
  { id: 'inbox',      label: 'Connected Inbox',     sub: 'Gmail · Outlook · App mail',      Icon: Mail        },
  { id: 'appearance', label: 'Appearance',           sub: 'Theme',                           Icon: Palette     },
  { id: 'team',       label: 'Team',                sub: 'Members · Teams · Availability',  Icon: Users       },
  { id: 'account',    label: 'Account & Security',  sub: 'Sessions · PIN · Sign out',       Icon: ShieldCheck },
];

export function SettingsRoute({ connection }: { connection: WhatsAppConnectionSnapshot | null }) {
  const [view, setView] = useState<SettingsView>('business');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* ── Left nav sidebar ── */}
      <aside
        className={`flex shrink-0 flex-col border-r border-border-subtle bg-surface-1 transition-all duration-200 ${sidebarOpen ? 'w-52' : 'w-14'}`}
      >
        {/* Sidebar header / toggle */}
        <div className="flex h-12 shrink-0 items-center border-b border-border-subtle px-3">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Collapse' : 'Expand'}
            className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            {sidebarOpen ? <PanelLeftClose size={15} aria-hidden /> : <PanelLeft size={15} aria-hidden />}
          </button>
          {sidebarOpen && <p className="ml-2 text-caption font-semibold text-fg">Settings</p>}
        </div>

        {/* Nav items */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {SETTINGS_NAV.map(({ id, label, sub, Icon }) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                title={sidebarOpen ? undefined : label}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-secondary hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <Icon size={15} className="shrink-0" aria-hidden />
                {sidebarOpen && (
                  <div className="min-w-0">
                    <p className={`text-caption font-medium ${active ? 'text-accent' : ''}`}>{label}</p>
                    <p className="truncate text-meta text-fg-muted">{sub}</p>
                  </div>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* ── Content panel ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {view === 'business' && (
          <div className="space-y-4">
            <SectionTitle title="Business" desc="Your workspace identity, WhatsApp connection, and location settings." />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <ProfileCard connection={connection} />
              <TimeLocationCard />
            </div>
          </div>
        )}

        {view === 'ai' && (
          <div className="space-y-4">
            <SectionTitle title="AI & Knowledge" desc="What your AI agents know and which external AI providers power them." />
            <KnowledgeBaseCard />
            <IntegrationSettingsPanel />
          </div>
        )}

        {view === 'appearance' && (
          <div className="space-y-4">
            <SectionTitle title="Appearance" desc="Theme is saved in this browser — applies instantly everywhere in the app." />
            <div className="max-w-lg space-y-4">
              <ThemeCard />
              <AlertBannerCard />
            </div>
          </div>
        )}

        {view === 'team' && (
          <div className="space-y-4">
            <SectionTitle title="Team" desc="Manage teammates, groups, and your personal availability." />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <TeamMembersCard />
              <TeamsCard />
            </div>
            <div className="max-w-lg">
              <AvailabilityCard />
            </div>
          </div>
        )}

        {view === 'inbox' && (
          <div className="space-y-4">
            <SectionTitle title="Connected Inbox" desc="Link Gmail and Outlook accounts to receive and read all your business email in one place." />
            <ConnectedInboxCard />
          </div>
        )}

        {view === 'account' && (
          <div className="space-y-4">
            <SectionTitle title="Account & Security" desc="Your signed-in session, screen lock PIN, and active devices." />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <AccountCard />
              <SecurityCard />
            </div>
            <SessionsCard />
            <OperatorModeCard />
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectedInboxCard() {
  type Account = {
    id: string;
    provider: 'gmail' | 'outlook';
    emailAddress: string;
    displayName: string | null;
    lastSyncedAt: string | null;
    syncEnabled: boolean;
  };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  function load() {
    api.listOAuthAccounts().then((r) => setAccounts(r.accounts)).catch(() => undefined).finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // Check for OAuth success/error redirected from callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get('oauth_success');
    const error = params.get('oauth_error');
    if (success || error) {
      window.history.replaceState({}, '', window.location.pathname);
      if (success) load();
    }
  }, []);

  async function handleSync(id: string) {
    setSyncingId(id);
    try { await api.syncOAuthAccount(id); load(); } finally { setSyncingId(null); }
  }

  async function handleDisconnect(id: string) {
    setDisconnectingId(id);
    try {
      await api.disconnectOAuthAccount(id);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } finally { setDisconnectingId(null); }
  }

  const PROVIDER_LABELS = { gmail: 'Gmail', outlook: 'Outlook' };
  const PROVIDER_COLORS: Record<string, string> = {
    gmail: 'bg-red-500/15 text-red-600 dark:text-red-400',
    outlook: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Mail size={16} className="text-accent" aria-hidden />
        <h3 className="text-body font-semibold text-fg">Connected email accounts</h3>
      </div>

      {loading ? (
        <p className="text-caption text-fg-muted">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="mb-4 text-caption text-fg-muted">No accounts connected yet. Link Gmail or Outlook to see all your email in one inbox.</p>
      ) : (
        <ul className="mb-4 divide-y divide-border-subtle">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${PROVIDER_COLORS[a.provider] ?? ''}`}>
                {PROVIDER_LABELS[a.provider] ?? a.provider}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-caption font-medium text-fg">{a.emailAddress}</p>
                {a.lastSyncedAt && (
                  <p className="text-meta text-fg-muted">
                    Last synced {new Date(a.lastSyncedAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={syncingId === a.id}
                  onClick={() => void handleSync(a.id)}
                  className="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-meta text-fg-secondary hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  <RefreshCw size={11} className={syncingId === a.id ? 'animate-spin' : ''} aria-hidden />
                  {syncingId === a.id ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  type="button"
                  disabled={disconnectingId === a.id}
                  onClick={() => void handleDisconnect(a.id)}
                  className="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-meta text-error/70 hover:border-error/40 hover:text-error disabled:opacity-40"
                >
                  <X size={11} aria-hidden />
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Connect buttons */}
      <div className="flex flex-wrap gap-3">
        {(['gmail', 'outlook'] as const).map((provider) => {
          const already = accounts.some((a) => a.provider === provider);
          return (
            <a
              key={provider}
              href={api.oauthConnectUrl(provider)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-caption font-medium transition-colors ${
                already
                  ? 'border-border-subtle text-fg-muted hover:border-accent hover:text-accent'
                  : 'border-accent/40 text-accent hover:bg-accent/5'
              }`}
            >
              <Mail size={13} aria-hidden />
              {already ? `Reconnect ${PROVIDER_LABELS[provider]}` : `Connect ${PROVIDER_LABELS[provider]}`}
            </a>
          );
        })}
      </div>

      <p className="mt-4 text-meta text-fg-muted">
        Accounts connect via OAuth — your passwords are never stored. Only read access is requested.
        You can disconnect at any time.
      </p>
    </div>
  );
}

function OperatorModeCard() {
  type Settings = { configured: true; operatorWaJid: string; enabled: boolean; updatedAt: string } | { configured: false };
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [jid, setJid] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  // WhatsApp setup token state
  const [waToken, setWaToken] = useState<string | null>(null);
  const [waTokenExists, setWaTokenExists] = useState<boolean | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getOperatorSettings().then(setSettings).catch(() => setSettings({ configured: false }));
    api.hasOperatorSetupToken().then((r) => setWaTokenExists(r.exists)).catch(() => setWaTokenExists(false));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!jid.trim()) { setErr('Enter a WhatsApp number (JID or phone).'); return; }
    if (pin.length < 4) { setErr('PIN must be at least 4 characters.'); return; }
    if (pin !== confirmPin) { setErr('PINs do not match.'); return; }
    setBusy(true);
    try {
      const result = await api.setOperatorSettings({ operatorWaJid: jid.trim(), pin });
      setSettings(result);
      setShowSetup(false);
      setPin('');
      setConfirmPin('');
      setOk(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle() {
    if (!settings?.configured) return;
    const next = !settings.enabled;
    await api.setOperatorEnabled(next).catch(() => undefined);
    setSettings({ ...settings, enabled: next });
  }

  async function handleKillSession() {
    await api.killOperatorSession().catch(() => undefined);
  }

  async function handleGenerateToken() {
    setTokenBusy(true);
    try {
      const { token } = await api.generateOperatorSetupToken();
      setWaToken(token);
      setWaTokenExists(true);
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleRevokeToken() {
    setTokenBusy(true);
    try {
      await api.revokeOperatorSetupToken();
      setWaToken(null);
      setWaTokenExists(false);
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const waSetupInstruction = waToken ? `setup operator ${waToken}` : null;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-body font-semibold text-fg flex items-center gap-2">
            <KeyRound size={15} aria-hidden className="text-fg-muted" />
            WhatsApp Operator Mode
          </h2>
          <p className="mt-1 text-caption text-fg-muted">
            Message your own business number from your personal WhatsApp to run admin commands — update records, log incidents, check stats — after PIN authentication. Only your registered number can access this.
          </p>
        </div>
        {settings?.configured && (
          <button
            type="button"
            onClick={() => void handleToggle()}
            className={`mt-0.5 shrink-0 rounded-full px-3 py-1 text-caption font-medium transition-colors ${settings.enabled ? 'bg-success/15 text-success' : 'bg-fg-muted/15 text-fg-muted'}`}
          >
            {settings.enabled ? 'Enabled' : 'Disabled'}
          </button>
        )}
      </div>

      {settings === null ? (
        <p className="mt-3 text-caption text-fg-muted">Loading…</p>
      ) : settings.configured ? (
        <div className="mt-4 space-y-2">
          <div className="rounded-lg bg-surface-1 px-3 py-2 text-caption text-fg-secondary">
            <span className="font-medium">Operator JID:</span> {settings.operatorWaJid}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setShowSetup(true); setJid(settings.operatorWaJid); }} className="text-caption text-accent underline-offset-2 hover:underline">
              Change setup
            </button>
            <span className="text-fg-muted">·</span>
            <button type="button" onClick={() => void handleKillSession()} className="text-caption text-fg-muted underline-offset-2 hover:underline hover:text-error">
              Kill active session
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowSetup(true)}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white hover:bg-accent-dim transition-colors"
        >
          Configure operator mode
        </button>
      )}

      {ok && !showSetup && (
        <p className="mt-3 text-caption text-success">✓ Operator mode configured. Test by messaging your business number from your personal WA.</p>
      )}

      {showSetup && (
        <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3 rounded-lg border border-border-subtle bg-surface-1 p-4">
          <p className="text-caption text-fg-muted">
            Enter your <strong>personal WhatsApp number</strong> (the one you'll message from) and a PIN you'll use to authenticate each session.
          </p>
          <div>
            <label className="mb-1 block text-caption font-medium text-fg">Your personal WA number</label>
            <input
              type="text"
              value={jid}
              onChange={(e) => setJid(e.target.value)}
              placeholder="e.g. +12461234567"
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="mt-1 text-caption text-fg-muted">Enter the full number with country code. The system stores this as-is.</p>
          </div>
          <div>
            <label className="mb-1 block text-caption font-medium text-fg">Operator PIN (min. 4 chars)</label>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label className="mb-1 block text-caption font-medium text-fg">Confirm PIN</label>
            <input type="password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)} placeholder="Confirm PIN" className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          {err && <p className="text-caption text-error">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white disabled:opacity-50 hover:bg-accent-dim transition-colors">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setShowSetup(false); setErr(null); setPin(''); setConfirmPin(''); }} className="rounded-lg border border-border-subtle px-4 py-2 text-caption text-fg-secondary hover:text-fg transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── WhatsApp Setup Code ────────────────────────────────────────────── */}
      <div className="mt-5 border-t border-border-subtle pt-4">
        <p className="text-caption font-medium text-fg">Set up via WhatsApp</p>
        <p className="mt-1 text-caption text-fg-muted">
          Generate a one-time code, then send it to your business number to configure operator mode directly from WhatsApp — no web form needed.
        </p>

        {waToken ? (
          <div className="mt-3 space-y-2">
            <p className="text-meta text-fg-muted">Send this message to your business WhatsApp number:</p>
            <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
              <code className="flex-1 select-all font-mono text-caption text-fg">{waSetupInstruction}</code>
              <button
                type="button"
                onClick={() => void handleCopy(waSetupInstruction!)}
                className="shrink-0 text-fg-muted hover:text-fg transition-colors"
                title="Copy"
              >
                <Clipboard size={14} aria-hidden />
              </button>
            </div>
            {copied && <p className="text-meta text-success">Copied!</p>}
            <p className="text-meta text-fg-muted">
              This code is only shown once. After sending, WhatsApp will walk you through setting your PIN. The code is burned after use.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleGenerateToken()}
                disabled={tokenBusy}
                className="flex items-center gap-1.5 text-caption text-fg-muted underline-offset-2 hover:underline disabled:opacity-50"
              >
                <RefreshCw size={12} aria-hidden />
                Regenerate
              </button>
              <span className="text-fg-muted">·</span>
              <button
                type="button"
                onClick={() => void handleRevokeToken()}
                disabled={tokenBusy}
                className="text-caption text-fg-muted underline-offset-2 hover:underline hover:text-error disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
          </div>
        ) : waTokenExists ? (
          <div className="mt-3 space-y-2">
            <p className="text-meta text-fg-muted">A setup code is active but the value is not shown again for security. Regenerate to get a new one.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleGenerateToken()}
                disabled={tokenBusy}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary hover:text-fg transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} aria-hidden />
                Regenerate code
              </button>
              <button
                type="button"
                onClick={() => void handleRevokeToken()}
                disabled={tokenBusy}
                className="text-caption text-fg-muted underline-offset-2 hover:underline hover:text-error disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void handleGenerateToken()}
            disabled={tokenBusy}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary hover:text-fg transition-colors disabled:opacity-50"
          >
            <KeyRound size={12} aria-hidden />
            {tokenBusy ? 'Generating…' : 'Generate setup code'}
          </button>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-title font-semibold text-fg">{title}</h2>
      <p className="mt-0.5 text-caption text-fg-muted">{desc}</p>
    </div>
  );
}
