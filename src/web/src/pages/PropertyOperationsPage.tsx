import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, Building2, CheckCircle2, ChevronRight, Clock,
  DollarSign, Filter, HardHat, Home, Loader2, Mail, MapPin, Package,
  Phone, Plus, RefreshCw, Search, ShieldAlert, ThumbsUp,
  Users, Wrench, X,
} from 'lucide-react';
import { ApprovalsPanel, platformApi, type ActionRequestRec } from '../components/ApprovalsPanel.js';

// ── Types ────────────────────────────────────────────────────────────────────

type PropertyRec = {
  id: string; name: string; propertyType: string; status: string;
  addressLine1: string | null; addressLine2: string | null; city: string | null;
  countryCode: string | null; timezone: string | null;
  guestInstructions: string | null; emergencyInstructions: string | null;
  createdAt: string;
};
type UnitRec = { id: string; propertyId: string; name: string; status: string; metadata: Record<string, unknown> };
type AssetRec = { id: string; unitId: string; category: string; name: string; manufacturer: string | null; model: string | null; serialNumber: string | null; location: string | null };
type VendorRec = { id: string; name: string; serviceCategories: string[]; phone: string | null; whatsappAddress: string | null; email: string | null; emergencyAvailable: boolean; active: boolean };
type IncidentRec = { id: string; propertyId: string; unitId: string | null; assetId: string | null; sourceChannel: string; title: string; description: string | null; category: string; severity: string; status: string; aiSummary: string | null; confidence: number | null; createdAt: string; updatedAt: string; resolvedAt: string | null };
type WorkOrderRec = { id: string; incidentId: string; vendorId: string | null; status: string; priority: string; scheduledFor: string | null; estimatedCostCents: number | null; approvedCostCents: number | null; description: string; completionNotes: string | null; createdAt: string; completedAt: string | null };
type Tab = 'overview' | 'properties' | 'incidents' | 'vendors' | 'approvals';
type SeverityFilter = 'ALL' | 'EMERGENCY' | 'PRIORITY' | 'ROUTINE';

// ── API helper ────────────────────────────────────────────────────────────────

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/property-operations${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { message?: string; error?: string }).message ?? (payload as { error?: string }).error ?? `Request failed (${response.status})`);
  return payload as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function severityRank(s: string) { return s === 'EMERGENCY' ? 0 : s === 'PRIORITY' ? 1 : 2; }
function fmtDate(v: string) { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDatetime(v: string) { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function fmtCents(c: number | null) { return c == null ? '—' : `$${(c / 100).toFixed(2)}`; }

// ── Shared micro-components ───────────────────────────────────────────────────

function SeverityBadge({ label }: { label: string }) {
  const cls = label === 'EMERGENCY' ? 'bg-error/10 text-error' : label === 'PRIORITY' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${cls}`}>{label}</span>;
}

function StatusBadge({ label }: { label: string }) {
  const cls = ['RESOLVED', 'CLOSED', 'COMPLETED'].includes(label) ? 'bg-success/10 text-success' : label === 'ESCALATED' ? 'bg-error/10 text-error' : label === 'PENDING_APPROVAL' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${cls}`}>{label.replace(/_/g, ' ')}</span>;
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Building2; label: string; value: number; tone?: 'error' | 'warning' }) {
  const cls = tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-fg';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-center gap-2 text-meta text-fg-muted"><Icon size={14} />{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Building2; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted"><Icon size={22} /></div>
      <p className="text-caption text-fg-muted">{text}</p>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return <div><p className="text-meta text-fg-muted">{label}</p><p className="mt-0.5 text-caption text-fg">{value}</p></div>;
}

function InlineForm({ children, onSubmit, busy }: { children: ReactNode; onSubmit: (e: FormEvent) => void; busy: boolean }) {
  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-4">
      {children}
      <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
        {busy && <Loader2 size={13} className="animate-spin" />}
        Save
      </button>
    </form>
  );
}

function FieldInput({ label, value, onChange, required, placeholder, maxLength }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string; maxLength?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}{required && <span className="ml-0.5 text-error">*</span>}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} required={required} placeholder={placeholder} maxLength={maxLength}
        className="field w-full border border-border-subtle bg-surface-0 text-fg" />
    </label>
  );
}

function FieldSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field w-full border border-border-subtle bg-surface-0 text-fg">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FieldTextarea({ label, value, onChange, placeholder, rows, maxLength, required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; maxLength?: number; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows ?? 3} maxLength={maxLength} required={required}
        className="field w-full resize-y border border-border-subtle bg-surface-0 text-fg" />
    </label>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({ properties, incidents, onGoTo }: { properties: PropertyRec[]; incidents: IncidentRec[]; onGoTo: (tab: Tab) => void }) {
  const openCount = incidents.filter((i) => !['RESOLVED', 'CLOSED'].includes(i.status)).length;
  const priorityCount = incidents.filter((i) => i.severity === 'PRIORITY').length;
  const emergencyCount = incidents.filter((i) => i.severity === 'EMERGENCY').length;
  const criticals = incidents.filter((i) => i.severity === 'EMERGENCY' && !['RESOLVED', 'CLOSED'].includes(i.status));
  const recent = [...incidents].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8);

  return (
    <div className="space-y-5">
      {criticals.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/30 bg-error/5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-error/10 text-error"><ShieldAlert size={18} /></span>
            <div className="min-w-0">
              <p className="text-caption font-medium text-error">{criticals.length} emergency {criticals.length === 1 ? 'incident requires' : 'incidents require'} immediate attention</p>
              <p className="truncate text-meta text-fg-muted">{criticals.slice(0, 2).map((i) => i.title).join(' · ')}</p>
            </div>
          </div>
          <button type="button" onClick={() => onGoTo('incidents')} className="inline-flex items-center gap-2 rounded-lg bg-error px-3 py-2 text-caption font-medium text-white">
            Review emergency queue <ChevronRight size={14} />
          </button>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Building2} label="Properties" value={properties.length} />
        <Metric icon={Wrench} label="Open incidents" value={openCount} />
        <Metric icon={AlertTriangle} label="Priority" value={priorityCount} tone="warning" />
        <Metric icon={ShieldAlert} label="Emergency" value={emergencyCount} tone="error" />
      </div>

      <section className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-medium text-fg">Recent incidents</h2>
          <button type="button" onClick={() => onGoTo('incidents')} className="text-caption text-accent hover:underline">View all</button>
        </div>
        {recent.length === 0
          ? <EmptyState icon={CheckCircle2} text="No incidents yet. Great news." />
          : (
            <div className="divide-y divide-border-subtle">
              {recent.map((inc) => (
                <div key={inc.id} className="flex items-center gap-3 px-4 py-3">
                  <SeverityBadge label={inc.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-medium text-fg">{inc.title}</p>
                    <p className="text-meta text-fg-muted">{inc.category} · {fmtDate(inc.createdAt)}</p>
                  </div>
                  <StatusBadge label={inc.status} />
                </div>
              ))}
            </div>
          )
        }
      </section>

      <section className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-medium text-fg">Properties</h2>
          <button type="button" onClick={() => onGoTo('properties')} className="text-caption text-accent hover:underline">Manage</button>
        </div>
        {properties.length === 0
          ? <EmptyState icon={Building2} text="No properties yet. Add one in the Properties tab." />
          : (
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {properties.map((p) => (
                <div key={p.id} className="rounded-lg border border-border-subtle bg-surface-0 p-3">
                  <p className="text-caption font-medium text-fg">{p.name}</p>
                  <p className="text-meta text-fg-muted">{p.propertyType}{p.city ? ` · ${p.city}` : ''}{p.countryCode ? `, ${p.countryCode}` : ''}</p>
                </div>
              ))}
            </div>
          )
        }
      </section>
    </div>
  );
}

// ── Properties tab ────────────────────────────────────────────────────────────

function PropertiesTab({ properties, onPropertiesChange }: { properties: PropertyRec[]; onPropertiesChange: () => void }) {
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [units, setUnits] = useState<UnitRec[]>([]);
  const [assets, setAssets] = useState<AssetRec[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Property form
  const [pName, setPName] = useState('');
  const [pType, setPType] = useState('VILLA');
  const [pStatus, setPStatus] = useState('ACTIVE');
  const [pAddress1, setPAddress1] = useState('');
  const [pCity, setPCity] = useState('');
  const [pCountry, setPCountry] = useState('');
  const [pGuest, setPGuest] = useState('');
  const [pEmergency, setPEmergency] = useState('');
  const [savingProperty, setSavingProperty] = useState(false);

  // Unit form
  const [uName, setUName] = useState('');
  const [savingUnit, setSavingUnit] = useState(false);

  // Asset form
  const [aCategory, setACategory] = useState('');
  const [aName, setAName] = useState('');
  const [aManufacturer, setAManufacturer] = useState('');
  const [aModel, setAModel] = useState('');
  const [aSerial, setASerial] = useState('');
  const [aLocation, setALocation] = useState('');
  const [aInstructions, setAInstructions] = useState('');
  const [savingAsset, setSavingAsset] = useState(false);

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null;
  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;

  async function loadUnits(propertyId: string) {
    setLoadingUnits(true);
    try { const data = await api<{ units: UnitRec[] }>(`/properties/${propertyId}/units`); setUnits(data.units); }
    catch { setUnits([]); }
    finally { setLoadingUnits(false); }
  }

  async function loadAssets(unitId: string) {
    setLoadingAssets(true);
    try { const data = await api<{ assets: AssetRec[] }>(`/units/${unitId}/assets`); setAssets(data.assets); }
    catch { setAssets([]); }
    finally { setLoadingAssets(false); }
  }

  function selectProperty(id: string) {
    setSelectedPropertyId(id); setSelectedUnitId(null); setUnits([]); setAssets([]);
    setShowAddUnit(false); setShowAddAsset(false);
    void loadUnits(id);
  }

  function selectUnit(id: string) {
    setSelectedUnitId(id); setAssets([]); setShowAddAsset(false);
    void loadAssets(id);
  }

  async function handleAddProperty(e: FormEvent) {
    e.preventDefault(); setSavingProperty(true); setError(null);
    try {
      const body: Record<string, unknown> = { name: pName.trim(), propertyType: pType, status: pStatus };
      if (pAddress1.trim()) body.addressLine1 = pAddress1.trim();
      if (pCity.trim()) body.city = pCity.trim();
      if (pCountry.trim()) body.countryCode = pCountry.trim().toUpperCase().slice(0, 2);
      if (pGuest.trim()) body.guestInstructions = pGuest.trim();
      if (pEmergency.trim()) body.emergencyInstructions = pEmergency.trim();
      await post('/properties', body);
      setPName(''); setPType('VILLA'); setPStatus('ACTIVE'); setPAddress1(''); setPCity(''); setPCountry(''); setPGuest(''); setPEmergency('');
      setShowAddProperty(false);
      onPropertiesChange();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create property'); }
    finally { setSavingProperty(false); }
  }

  async function handleAddUnit(e: FormEvent) {
    e.preventDefault(); if (!selectedPropertyId) return;
    setSavingUnit(true); setError(null);
    try {
      await post(`/properties/${selectedPropertyId}/units`, { name: uName.trim() });
      setUName(''); setShowAddUnit(false);
      await loadUnits(selectedPropertyId);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create unit'); }
    finally { setSavingUnit(false); }
  }

  async function handleAddAsset(e: FormEvent) {
    e.preventDefault(); if (!selectedUnitId) return;
    setSavingAsset(true); setError(null);
    try {
      const body: Record<string, unknown> = { category: aCategory.trim(), name: aName.trim() };
      if (aManufacturer.trim()) body.manufacturer = aManufacturer.trim();
      if (aModel.trim()) body.model = aModel.trim();
      if (aSerial.trim()) body.serialNumber = aSerial.trim();
      if (aLocation.trim()) body.location = aLocation.trim();
      if (aInstructions.trim()) body.instructions = aInstructions.trim();
      await post(`/units/${selectedUnitId}/assets`, body);
      setACategory(''); setAName(''); setAManufacturer(''); setAModel(''); setASerial(''); setALocation(''); setAInstructions('');
      setShowAddAsset(false);
      await loadAssets(selectedUnitId);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create asset'); }
    finally { setSavingAsset(false); }
  }

  const PROPERTY_TYPES = ['VILLA', 'APARTMENT', 'HOUSE', 'CONDO', 'COMMERCIAL', 'OFFICE', 'LAND', 'OTHER'].map((v) => ({ value: v, label: v }));

  return (
    <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
      {/* ── Left: property list ── */}
      <aside className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-medium text-fg">Properties</h2>
          <button type="button" onClick={() => setShowAddProperty((v) => !v)} title="Add property"
            className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
            {showAddProperty ? <X size={15} /> : <Plus size={15} />}
          </button>
        </div>

        {showAddProperty && (
          <div className="border-b border-border-subtle p-4">
            <p className="mb-3 text-caption font-medium text-fg">Add property</p>
            <form onSubmit={(e) => void handleAddProperty(e)} className="space-y-2">
              <FieldInput label="Property name" value={pName} onChange={setPName} required placeholder="Sunset Villa" />
              <div className="grid grid-cols-2 gap-2">
                <FieldSelect label="Type" value={pType} onChange={setPType} options={PROPERTY_TYPES} />
                <FieldSelect label="Status" value={pStatus} onChange={setPStatus} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} />
              </div>
              <FieldInput label="Address" value={pAddress1} onChange={setPAddress1} placeholder="123 Worthing Road" />
              <div className="grid grid-cols-2 gap-2">
                <FieldInput label="City" value={pCity} onChange={setPCity} placeholder="Bridgetown" />
                <FieldInput label="Country code" value={pCountry} onChange={setPCountry} placeholder="BB" maxLength={2} />
              </div>
              <FieldTextarea label="Guest instructions" value={pGuest} onChange={setPGuest} placeholder="Check-in info, WiFi, house rules…" rows={2} />
              <FieldTextarea label="Emergency instructions" value={pEmergency} onChange={setPEmergency} placeholder="Breaker location, shut-off valves…" rows={2} />
              <button type="submit" disabled={savingProperty} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white disabled:opacity-50">
                {savingProperty ? <Loader2 size={13} className="animate-spin" /> : null} Add property
              </button>
            </form>
          </div>
        )}

        {error && <p className="px-4 py-2 text-caption text-error">{error}</p>}

        <div className="max-h-[480px] overflow-y-auto p-2">
          {properties.length === 0 && <p className="px-3 py-4 text-caption text-fg-muted">No properties yet.</p>}
          {properties.map((p) => (
            <button key={p.id} type="button" onClick={() => selectProperty(p.id)}
              className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition ${selectedPropertyId === p.id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
              <span className="min-w-0">
                <span className="block truncate text-caption font-medium">{p.name}</span>
                <span className="block truncate text-meta text-fg-muted">{p.propertyType}{p.city ? ` · ${p.city}` : ''}</span>
              </span>
              <ChevronRight size={14} className="shrink-0" />
            </button>
          ))}
        </div>
      </aside>

      {/* ── Right: units + assets ── */}
      <div className="space-y-5">
        {!selectedProperty && (
          <div className="rounded-xl border border-border-subtle bg-surface-1">
            <EmptyState icon={Building2} text="Select a property on the left to view its units and assets." />
          </div>
        )}

        {selectedProperty && (
          <>
            {/* Property detail header */}
            <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-meta uppercase tracking-wide text-fg-muted">{selectedProperty.propertyType}</p>
                  <h2 className="mt-0.5 text-title font-semibold text-fg">{selectedProperty.name}</h2>
                  {(selectedProperty.addressLine1 || selectedProperty.city) && (
                    <p className="mt-1 flex items-center gap-1.5 text-caption text-fg-muted">
                      <MapPin size={13} />
                      {[selectedProperty.addressLine1, selectedProperty.city, selectedProperty.countryCode].filter(Boolean).join(', ')}
                    </p>
                  )}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-meta font-medium ${selectedProperty.status === 'ACTIVE' ? 'bg-success/10 text-success' : 'bg-surface-2 text-fg-muted'}`}>
                  {selectedProperty.status}
                </span>
              </div>
              {selectedProperty.guestInstructions && (
                <div className="mt-3 rounded-lg bg-surface-2 p-3">
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Guest instructions</p>
                  <p className="mt-1 text-caption text-fg-secondary">{selectedProperty.guestInstructions}</p>
                </div>
              )}
            </div>

            {/* Units */}
            <div className="rounded-xl border border-border-subtle bg-surface-1">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <h3 className="text-body font-medium text-fg">Units <span className="ml-1 text-meta text-fg-muted">({units.length})</span></h3>
                <button type="button" onClick={() => setShowAddUnit((v) => !v)} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
                  {showAddUnit ? <X size={15} /> : <Plus size={15} />}
                </button>
              </div>
              {showAddUnit && (
                <div className="border-b border-border-subtle p-4">
                  <form onSubmit={(e) => void handleAddUnit(e)} className="flex items-end gap-2">
                    <div className="flex-1">
                      <FieldInput label="Unit name" value={uName} onChange={setUName} required placeholder="Unit 1A" />
                    </div>
                    <button type="submit" disabled={savingUnit} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white disabled:opacity-50">
                      {savingUnit ? <Loader2 size={13} className="animate-spin" /> : null} Add
                    </button>
                  </form>
                </div>
              )}
              {loadingUnits && <p className="px-4 py-4 text-caption text-fg-muted">Loading units…</p>}
              {!loadingUnits && units.length === 0 && <EmptyState icon={Home} text="No units yet. Use the + button above to add one." />}
              <div className="divide-y divide-border-subtle">
                {units.map((u) => (
                  <button key={u.id} type="button" onClick={() => selectUnit(u.id)}
                    className={`flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-surface-2 ${selectedUnitId === u.id ? 'bg-accent-soft/50' : ''}`}>
                    <span className="flex items-center gap-2">
                      <Home size={14} className="shrink-0 text-fg-muted" />
                      <span className="text-caption font-medium text-fg">{u.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-meta ${u.status === 'ACTIVE' ? 'bg-success/10 text-success' : 'bg-surface-2 text-fg-muted'}`}>{u.status}</span>
                    </span>
                    <ChevronRight size={14} className="shrink-0 text-fg-muted" />
                  </button>
                ))}
              </div>
            </div>

            {/* Assets (only when a unit is selected) */}
            {selectedUnit && (
              <div className="rounded-xl border border-border-subtle bg-surface-1">
                <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                  <h3 className="text-body font-medium text-fg">
                    Assets in <span className="text-accent">{selectedUnit.name}</span>
                    <span className="ml-1 text-meta text-fg-muted">({assets.length})</span>
                  </h3>
                  <button type="button" onClick={() => setShowAddAsset((v) => !v)} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
                    {showAddAsset ? <X size={15} /> : <Plus size={15} />}
                  </button>
                </div>
                {showAddAsset && (
                  <div className="border-b border-border-subtle p-4">
                    <p className="mb-3 text-caption font-medium text-fg">Add asset to {selectedUnit.name}</p>
                    <form onSubmit={(e) => void handleAddAsset(e)} className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <FieldInput label="Category" value={aCategory} onChange={setACategory} required placeholder="HVAC" />
                        <FieldInput label="Name" value={aName} onChange={setAName} required placeholder="Split-unit AC" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <FieldInput label="Manufacturer" value={aManufacturer} onChange={setAManufacturer} placeholder="Mitsubishi" />
                        <FieldInput label="Model" value={aModel} onChange={setAModel} placeholder="MSZ-GL12NA" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <FieldInput label="Serial number" value={aSerial} onChange={setASerial} />
                        <FieldInput label="Location in unit" value={aLocation} onChange={setALocation} placeholder="Master bedroom" />
                      </div>
                      <FieldTextarea label="Maintenance instructions" value={aInstructions} onChange={setAInstructions} placeholder="Filter replaced monthly. Service annually." rows={2} />
                      <button type="submit" disabled={savingAsset} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white disabled:opacity-50">
                        {savingAsset ? <Loader2 size={13} className="animate-spin" /> : null} Add asset
                      </button>
                    </form>
                  </div>
                )}
                {loadingAssets && <p className="px-4 py-4 text-caption text-fg-muted">Loading assets…</p>}
                {!loadingAssets && assets.length === 0 && <EmptyState icon={Package} text="No assets recorded for this unit." />}
                <div className="divide-y divide-border-subtle">
                  {assets.map((a) => (
                    <div key={a.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Package size={13} className="shrink-0 text-fg-muted" />
                            <p className="text-caption font-medium text-fg">{a.name}</p>
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-meta text-fg-muted">{a.category}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-muted">
                            {a.manufacturer && <span>{a.manufacturer}{a.model ? ` ${a.model}` : ''}</span>}
                            {a.serialNumber && <span>S/N {a.serialNumber}</span>}
                            {a.location && <span className="flex items-center gap-1"><MapPin size={11} />{a.location}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Incidents tab ─────────────────────────────────────────────────────────────

function IncidentsTab({ incidents, properties, onIncidentsChange }: { incidents: IncidentRec[]; properties: PropertyRec[]; onIncidentsChange: () => void }) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [propertyFilter, setPropertyFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrderRec[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [showIntake, setShowIntake] = useState(false);

  // Intake form state
  const [iPropertyId, setIPropertyId] = useState('');
  const [iChannel, setIChannel] = useState<'WEB' | 'WHATSAPP' | 'EMAIL' | 'VOICE' | 'SMS'>('WEB');
  const [iDescription, setIDescription] = useState('');
  const [iTitle, setITitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [intakeResult, setIntakeResult] = useState<{ severity: string; category: string; nextStep: string } | null>(null);

  const emergencyCount = incidents.filter((i) => i.severity === 'EMERGENCY').length;
  const priorityCount = incidents.filter((i) => i.severity === 'PRIORITY').length;
  const routineCount = incidents.filter((i) => i.severity === 'ROUTINE').length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return incidents
      .filter((i) => !propertyFilter || i.propertyId === propertyFilter)
      .filter((i) => severityFilter === 'ALL' || i.severity === severityFilter)
      .filter((i) => !q || [i.title, i.category, i.status, i.severity, i.aiSummary ?? ''].join(' ').toLowerCase().includes(q))
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [incidents, query, propertyFilter, severityFilter]);

  const selected = useMemo(() => incidents.find((i) => i.id === selectedId) ?? filtered[0] ?? null, [incidents, selectedId, filtered]);
  const selectedProperty = selected ? properties.find((p) => p.id === selected.propertyId) : null;

  useEffect(() => {
    if (selectedId && !filtered.some((i) => i.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  const refetchWorkOrders = useCallback((incidentId: string) => {
    setLoadingOrders(true);
    return api<{ workOrders: WorkOrderRec[] }>(`/work-orders?incidentId=${incidentId}`)
      .then((d) => setWorkOrders(d.workOrders))
      .catch(() => setWorkOrders([]))
      .finally(() => setLoadingOrders(false));
  }, []);

  useEffect(() => {
    if (!selected) { setWorkOrders([]); return; }
    void refetchWorkOrders(selected.id);
  }, [selected?.id, refetchWorkOrders]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  async function handleIncidentStatus(incidentId: string, status: 'RESOLVED' | 'CLOSED') {
    setActionBusyId(incidentId); setActionError(null);
    try {
      await patch(`/incidents/${incidentId}`, { status });
      onIncidentsChange();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to update incident'); }
    finally { setActionBusyId(null); }
  }

  async function handleApproveWorkOrder(workOrderId: string, incidentId: string, costInput: string) {
    const trimmed = costInput.trim();
    const approvedCostCents = trimmed ? Math.round(Number(trimmed) * 100) : undefined;
    if (trimmed && (!Number.isFinite(approvedCostCents) || (approvedCostCents ?? 0) < 0)) { setActionError('Enter a valid approved cost.'); return; }
    setActionBusyId(workOrderId); setActionError(null);
    try {
      await patch(`/work-orders/${workOrderId}`, { status: 'APPROVED', ...(approvedCostCents !== undefined ? { approvedCostCents } : {}) });
      await refetchWorkOrders(incidentId);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to approve work order'); }
    finally { setActionBusyId(null); }
  }

  async function handleCompleteWorkOrder(workOrderId: string, incidentId: string, notes: string) {
    setActionBusyId(workOrderId); setActionError(null);
    try {
      await patch(`/work-orders/${workOrderId}`, { status: 'COMPLETED', ...(notes.trim() ? { completionNotes: notes.trim() } : {}) });
      await refetchWorkOrders(incidentId);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to complete work order'); }
    finally { setActionBusyId(null); }
  }

  async function handleCancelWorkOrder(workOrderId: string, incidentId: string) {
    setActionBusyId(workOrderId); setActionError(null);
    try {
      await patch(`/work-orders/${workOrderId}`, { status: 'CANCELLED' });
      await refetchWorkOrders(incidentId);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to cancel work order'); }
    finally { setActionBusyId(null); }
  }

  async function handleIntake(e: FormEvent) {
    e.preventDefault(); setSubmitting(true); setIntakeError(null); setIntakeResult(null);
    try {
      const body: Record<string, unknown> = { propertyId: iPropertyId, channel: iChannel, description: iDescription.trim() };
      if (iTitle.trim()) body.title = iTitle.trim();
      const data = await post<{ incident: IncidentRec; classification: { category: string; urgency: string; recommendedNextStep: string }; workOrderDraft: WorkOrderRec | null }>('/incidents/intake', body);
      setIntakeResult({ severity: data.classification.urgency, category: data.classification.category, nextStep: data.classification.recommendedNextStep });
      setIDescription(''); setITitle('');
      onIncidentsChange();
    } catch (err) { setIntakeError(err instanceof Error ? err.message : 'Failed to log incident'); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_340px]">
      {/* ── Triage queue sidebar ── */}
      <aside className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="border-b border-border-subtle px-4 py-3">
          <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Triage queue</p>
        </div>
        <div className="space-y-0.5 p-2">
          {([
            { id: 'ALL', label: 'All', icon: Wrench, count: incidents.length },
            { id: 'EMERGENCY', label: 'Emergency', icon: ShieldAlert, count: emergencyCount, tone: 'error' as const },
            { id: 'PRIORITY', label: 'Priority', icon: AlertTriangle, count: priorityCount, tone: 'warning' as const },
            { id: 'ROUTINE', label: 'Routine', icon: CheckCircle2, count: routineCount },
          ] as { id: SeverityFilter; label: string; icon: typeof Wrench; count: number; tone?: 'error' | 'warning' }[]).map(({ id, label, icon: Icon, count, tone }) => (
            <button key={id} type="button" onClick={() => setSeverityFilter(id)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition ${severityFilter === id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
              <span className="flex items-center gap-2 text-caption font-medium">
                <Icon size={14} className={severityFilter === id ? 'text-accent' : tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-fg-muted'} />
                {label}
              </span>
              <span className="text-meta text-fg-muted">{count}</span>
            </button>
          ))}
        </div>

        <div className="border-y border-border-subtle px-4 py-3">
          <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Properties</p>
        </div>
        <div className="max-h-[260px] overflow-y-auto p-2">
          <button type="button" onClick={() => setPropertyFilter(null)}
            className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-caption ${propertyFilter === null ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
            <span className="font-medium">All properties</span><span className="text-meta text-fg-muted">{properties.length}</span>
          </button>
          {properties.map((p) => (
            <button key={p.id} type="button" onClick={() => setPropertyFilter(p.id)}
              className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ${propertyFilter === p.id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
              <span className="min-w-0 text-caption font-medium">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="border-t border-border-subtle p-2">
          <button type="button" onClick={() => setShowIntake((v) => !v)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-caption font-medium transition ${showIntake ? 'bg-accent-soft text-accent' : 'text-fg-secondary hover:bg-surface-2'}`}>
            <Plus size={14} /> Log incident
          </button>
        </div>
      </aside>

      {/* ── Centre: incident list or intake form ── */}
      <section className="min-w-0 rounded-xl border border-border-subtle bg-surface-1">
        {showIntake ? (
          <>
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-body font-medium text-fg">Log incident</h2>
                <p className="mt-0.5 text-meta text-fg-muted">AI will classify severity and create a work order draft if needed.</p>
              </div>
              <button type="button" onClick={() => { setShowIntake(false); setIntakeResult(null); setIntakeError(null); }}
                className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2"><X size={15} /></button>
            </div>
            <div className="p-5">
              {intakeResult && (
                <div className="mb-4 rounded-xl border border-success/30 bg-success/5 p-4">
                  <p className="text-caption font-medium text-success">Incident logged</p>
                  <p className="mt-1 text-meta text-fg-muted">Severity: <strong>{intakeResult.severity}</strong> · Category: <strong>{intakeResult.category}</strong> · Next step: <strong>{intakeResult.nextStep.replace(/_/g, ' ')}</strong></p>
                </div>
              )}
              {intakeError && <p className="mb-3 text-caption text-error">{intakeError}</p>}
              <form onSubmit={(e) => void handleIntake(e)} className="space-y-3">
                <FieldSelect label="Property" value={iPropertyId} onChange={setIPropertyId}
                  options={[{ value: '', label: '— choose property —' }, ...properties.map((p) => ({ value: p.id, label: p.name }))]} />
                <FieldInput label="Title (optional)" value={iTitle} onChange={setITitle} placeholder="Leaking pipe in bathroom" />
                <FieldTextarea label="Description" value={iDescription} onChange={setIDescription} required
                  placeholder="Describe the issue in detail. The AI will classify urgency automatically." rows={5} />
                <FieldSelect label="Channel" value={iChannel} onChange={(v) => setIChannel(v as typeof iChannel)}
                  options={[
                    { value: 'WEB', label: 'Web (manual entry)' },
                    { value: 'WHATSAPP', label: 'WhatsApp' },
                    { value: 'EMAIL', label: 'Email' },
                    { value: 'VOICE', label: 'Voice call' },
                    { value: 'SMS', label: 'SMS' },
                  ]} />
                <button type="submit" disabled={submitting || !iPropertyId || !iDescription.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white disabled:opacity-50">
                  {submitting ? <Loader2 size={13} className="animate-spin" /> : null}
                  {submitting ? 'Classifying…' : 'Log incident'}
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-body font-medium text-fg">Incidents</h2>
                <p className="mt-0.5 text-meta text-fg-muted">Emergency and priority ranked first.</p>
              </div>
              <span className="rounded-full bg-surface-2 px-2 py-1 text-meta text-fg-muted">{filtered.length}</span>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
              <label className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-fg-muted focus-within:border-accent">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search incidents"
                  className="min-w-0 flex-1 bg-transparent text-caption text-fg outline-none placeholder:text-fg-muted" />
                {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={13} /></button>}
              </label>
              <button type="button" onClick={() => { setQuery(''); setSeverityFilter('ALL'); setPropertyFilter(null); }}
                className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-caption text-fg-muted hover:bg-surface-2">
                <Filter size={13} /> Clear
              </button>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div className="grid grid-cols-[1fr_100px_90px_90px_36px] gap-3 border-b border-border-subtle bg-surface-2/40 px-4 py-2 text-meta font-medium uppercase tracking-wide text-fg-muted">
                  <span>Incident</span><span>Category</span><span>Urgency</span><span>Status</span><span />
                </div>
                {filtered.length === 0 && <EmptyState icon={CheckCircle2} text="No incidents match this view." />}
                {filtered.map((inc) => (
                  <button key={inc.id} type="button" onClick={() => setSelectedId(inc.id)}
                    className={`grid w-full grid-cols-[1fr_100px_90px_90px_36px] items-center gap-3 border-b border-border-subtle px-4 py-3 text-left transition hover:bg-surface-2/70 ${selected?.id === inc.id ? 'bg-accent-soft/50' : ''}`}>
                    <span className="min-w-0">
                      <span className="block truncate text-caption font-medium text-fg">{inc.title}</span>
                      <span className="mt-0.5 block text-meta text-fg-muted">{fmtDate(inc.createdAt)}</span>
                    </span>
                    <span className="truncate text-caption text-fg-secondary">{inc.category}</span>
                    <SeverityBadge label={inc.severity} />
                    <StatusBadge label={inc.status} />
                    <ChevronRight size={15} className="justify-self-end text-fg-muted" />
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Right: incident detail ── */}
      <aside className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="border-b border-border-subtle px-4 py-3">
          <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Incident detail</p>
          {selected && <h2 className="mt-1 text-caption font-medium text-fg">{selected.title}</h2>}
        </div>
        {!selected
          ? <EmptyState icon={Wrench} text="Select an incident to review details." />
          : (
            <div className="space-y-5 overflow-y-auto p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <SeverityBadge label={selected.severity} />
                  <StatusBadge label={selected.status} />
                </div>
                {!['RESOLVED', 'CLOSED'].includes(selected.status) && (
                  <div className="flex gap-2">
                    <button type="button" disabled={actionBusyId === selected.id} onClick={() => void handleIncidentStatus(selected.id, 'RESOLVED')}
                      className="rounded-lg border border-success/30 px-3 py-1.5 text-caption font-medium text-success hover:bg-success/10 disabled:opacity-50">
                      Mark resolved
                    </button>
                    <button type="button" disabled={actionBusyId === selected.id} onClick={() => void handleIncidentStatus(selected.id, 'CLOSED')}
                      className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50">
                      Close
                    </button>
                  </div>
                )}
              </div>
              {actionError && <p className="text-caption text-error">{actionError}</p>}

              <div className="grid grid-cols-2 gap-3">
                <FieldRow label="Category" value={selected.category} />
                <FieldRow label="Channel" value={selected.sourceChannel} />
                <FieldRow label="Reported" value={fmtDatetime(selected.createdAt)} />
                {selected.resolvedAt && <FieldRow label="Resolved" value={fmtDatetime(selected.resolvedAt)} />}
                {selectedProperty && <FieldRow label="Property" value={selectedProperty.name} />}
              </div>

              {selected.aiSummary && (
                <div>
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">AI summary</p>
                  <p className="mt-2 rounded-lg bg-surface-2 p-3 text-caption leading-6 text-fg-secondary">{selected.aiSummary}</p>
                </div>
              )}

              {selected.description && (
                <div>
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Description</p>
                  <p className="mt-2 text-caption leading-6 text-fg-secondary">{selected.description}</p>
                </div>
              )}

              {selected.confidence != null && (
                <div>
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">AI confidence</p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(selected.confidence * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-right text-meta text-fg-muted">{Math.round(selected.confidence * 100)}%</p>
                </div>
              )}

              {/* Work orders */}
              <div>
                <p className="mb-2 text-meta font-medium uppercase tracking-wide text-fg-muted">Work orders</p>
                {loadingOrders && <p className="text-caption text-fg-muted">Loading…</p>}
                {!loadingOrders && workOrders.length === 0 && <p className="text-caption text-fg-muted">No work orders for this incident.</p>}
                {workOrders.map((wo) => (
                  <WorkOrderCard key={wo.id} workOrder={wo} busy={actionBusyId === wo.id}
                    onApprove={(cost) => handleApproveWorkOrder(wo.id, selected.id, cost)}
                    onComplete={(notes) => handleCompleteWorkOrder(wo.id, selected.id, notes)}
                    onCancel={() => handleCancelWorkOrder(wo.id, selected.id)}
                  />
                ))}
              </div>
            </div>
          )
        }
      </aside>
    </div>
  );
}

/**
 * Section 60-62: work orders (and incidents, above) had zero mutation
 * path anywhere before this - createWorkOrder was the only write this
 * table ever had, so a work order stayed PENDING_APPROVAL forever no
 * matter what actually happened with the vendor. These three buttons are
 * the whole real lifecycle: approve (optionally with a real cost),
 * complete (optionally with real notes), or cancel.
 */
function WorkOrderCard({
  workOrder, busy, onApprove, onComplete, onCancel,
}: {
  workOrder: WorkOrderRec;
  busy: boolean;
  onApprove: (costInput: string) => void;
  onComplete: (notes: string) => void;
  onCancel: () => void;
}) {
  const [costInput, setCostInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
  const actionable = !['COMPLETED', 'CANCELLED'].includes(workOrder.status);

  return (
    <div className="mb-2 rounded-lg border border-border-subtle bg-surface-0 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <StatusBadge label={workOrder.status} />
        <SeverityBadge label={workOrder.priority} />
      </div>
      <p className="text-caption text-fg">{workOrder.description}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-muted">
        {workOrder.scheduledFor && <span className="flex items-center gap-1"><Clock size={11} />{fmtDate(workOrder.scheduledFor)}</span>}
        {workOrder.estimatedCostCents != null && <span className="flex items-center gap-1"><DollarSign size={11} />Est. {fmtCents(workOrder.estimatedCostCents)}</span>}
        {workOrder.approvedCostCents != null && <span className="flex items-center gap-1"><DollarSign size={11} />Approved {fmtCents(workOrder.approvedCostCents)}</span>}
      </div>
      {workOrder.completionNotes && <p className="text-meta text-fg-muted">Notes: {workOrder.completionNotes}</p>}

      {actionable && (
        <div className="space-y-2 border-t border-border-subtle pt-2">
          {workOrder.status === 'PENDING_APPROVAL' || workOrder.status === 'PENDING_POLICY' ? (
            <div className="flex items-center gap-2">
              <input type="number" min={0} step="0.01" placeholder="Approved cost (optional)" value={costInput} onChange={(e) => setCostInput(e.target.value)}
                className="w-32 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" disabled={busy} onClick={() => onApprove(costInput)}
                className="rounded-md bg-success/10 px-2 py-1 text-meta font-medium text-success hover:bg-success/20 disabled:opacity-50">
                Approve
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input type="text" placeholder="Completion notes (optional)" value={notesInput} onChange={(e) => setNotesInput(e.target.value)}
                className="w-40 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" disabled={busy} onClick={() => onComplete(notesInput)}
                className="rounded-md bg-success/10 px-2 py-1 text-meta font-medium text-success hover:bg-success/20 disabled:opacity-50">
                Mark completed
              </button>
            </div>
          )}
          <button type="button" disabled={busy} onClick={onCancel}
            className="text-meta font-medium text-error hover:underline disabled:opacity-50">
            Cancel work order
          </button>
        </div>
      )}
    </div>
  );
}

// ── Vendors tab ───────────────────────────────────────────────────────────────

function VendorsTab() {
  const [vendors, setVendors] = useState<VendorRec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form
  const [vName, setVName] = useState('');
  const [vCategories, setVCategories] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [vWhatsapp, setVWhatsapp] = useState('');
  const [vEmail, setVEmail] = useState('');
  const [vEmergency, setVEmergency] = useState(false);

  async function load() {
    try { const d = await api<{ vendors: VendorRec[] }>('/vendors'); setVendors(d.vendors); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load vendors'); }
  }

  useEffect(() => { void load(); }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      const categories = vCategories.split(',').map((s) => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = { name: vName.trim(), serviceCategories: categories, emergencyAvailable: vEmergency };
      if (vPhone.trim()) body.phone = vPhone.trim();
      if (vWhatsapp.trim()) body.whatsappAddress = vWhatsapp.trim();
      if (vEmail.trim()) body.email = vEmail.trim();
      await post('/vendors', body);
      setVName(''); setVCategories(''); setVPhone(''); setVWhatsapp(''); setVEmail(''); setVEmergency(false);
      setShowAdd(false);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create vendor'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-title font-semibold text-fg">Vendors & contractors</h2>
          <p className="mt-0.5 text-caption text-fg-muted">Plumbers, electricians, and other service providers for your properties.</p>
        </div>
        <button type="button" onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2">
          {showAdd ? <X size={14} /> : <Plus size={14} />}
          {showAdd ? 'Cancel' : 'Add vendor'}
        </button>
      </div>

      {error && <p className="mb-4 text-caption text-error">{error}</p>}

      {showAdd && (
        <div className="mb-5 rounded-xl border border-border-subtle bg-surface-1 p-5">
          <p className="mb-3 text-body font-medium text-fg">Add vendor</p>
          <form onSubmit={(e) => void handleAdd(e)} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FieldInput label="Name" value={vName} onChange={setVName} required placeholder="Island Plumbing Ltd." />
            </div>
            <FieldInput label="Service categories (comma-separated)" value={vCategories} onChange={setVCategories} placeholder="PLUMBING, HVAC" />
            <FieldInput label="Phone" value={vPhone} onChange={setVPhone} placeholder="+12465551234" />
            <FieldInput label="WhatsApp number" value={vWhatsapp} onChange={setVWhatsapp} placeholder="+12465551234" />
            <FieldInput label="Email" value={vEmail} onChange={setVEmail} placeholder="contact@example.com" />
            <div className="sm:col-span-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={vEmergency} onChange={(e) => setVEmergency(e.target.checked)}
                  className="h-4 w-4 rounded border-border-subtle accent-accent" />
                <span className="text-caption text-fg">Available for emergency call-outs</span>
              </label>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white disabled:opacity-50">
                {saving ? <Loader2 size={13} className="animate-spin" /> : null} Add vendor
              </button>
            </div>
          </form>
        </div>
      )}

      {vendors === null && <p className="text-caption text-fg-muted">Loading vendors…</p>}
      {vendors !== null && vendors.length === 0 && <EmptyState icon={HardHat} text="No vendors yet. Add your first contractor above." />}

      {vendors && vendors.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {vendors.map((v) => (
            <div key={v.id} className="rounded-xl border border-border-subtle bg-surface-1 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-caption font-semibold text-fg">{v.name}</p>
                  {v.emergencyAvailable && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-error/10 px-2 py-0.5 text-meta font-medium text-error">
                      <ShieldAlert size={10} /> Emergency
                    </span>
                  )}
                </div>
              </div>
              {v.serviceCategories.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {v.serviceCategories.map((c) => (
                    <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5 text-meta text-fg-muted">{c}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 space-y-1 text-meta text-fg-muted">
                {v.phone && <p className="flex items-center gap-1.5"><Phone size={12} />{v.phone}</p>}
                {v.whatsappAddress && <p className="flex items-center gap-1.5"><Users size={12} />WA: {v.whatsappAddress}</p>}
                {v.email && <p className="flex items-center gap-1.5"><Mail size={12} />{v.email}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: typeof Building2 }[] = [
  { id: 'overview',    label: 'Overview',    icon: Building2   },
  { id: 'properties', label: 'Properties',  icon: Home        },
  { id: 'incidents',  label: 'Incidents',   icon: Wrench      },
  { id: 'approvals',  label: 'Approvals',   icon: ThumbsUp    },
  { id: 'vendors',    label: 'Vendors',     icon: HardHat     },
];

export function PropertyOperationsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [properties, setProperties] = useState<PropertyRec[]>([]);
  const [incidents, setIncidents] = useState<IncidentRec[]>([]);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pd, id_, approvalData] = await Promise.all([
        api<{ properties: PropertyRec[] }>('/properties'),
        api<{ incidents: IncidentRec[] }>('/incidents'),
        platformApi<{ approvals: ActionRequestRec[] }>('/approvals/pending').catch(() => ({ approvals: [] })),
      ]);
      setProperties(pd.properties);
      setIncidents(id_.incidents);
      setPendingApprovalCount(approvalData.approvals.length);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load property operations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const emergencyCount = incidents.filter((i) => i.severity === 'EMERGENCY' && !['RESOLVED', 'CLOSED'].includes(i.status)).length;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface-0">
      {/* Header */}
      <div className="border-b border-border-subtle bg-surface-1 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-meta uppercase tracking-widest text-fg-muted">Operations command centre</p>
            <h1 className="mt-1 text-2xl font-semibold text-fg">Property Operations</h1>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-caption text-fg hover:bg-surface-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {/* Tab nav */}
        <nav className="mt-4 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            const badge = (id === 'incidents' && emergencyCount > 0) ? emergencyCount : (id === 'approvals' && pendingApprovalCount > 0) ? pendingApprovalCount : null;
            return (
              <button key={id} type="button" onClick={() => setTab(id)}
                className={`relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-caption font-medium transition ${active ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-surface-2 hover:text-fg'}`}>
                <Icon size={14} />
                {label}
                {badge != null && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-error text-[10px] font-bold text-white">{badge > 9 ? '9+' : badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-error/30 px-3 py-1.5 text-meta hover:bg-error/10">Try again</button>
          </div>
        )}
        {loading && !properties.length && !incidents.length && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-fg-muted" />
          </div>
        )}

        {(!loading || properties.length > 0 || incidents.length > 0) && (
          <>
            {tab === 'overview' && <OverviewTab properties={properties} incidents={incidents} onGoTo={setTab} />}
            {tab === 'properties' && <PropertiesTab properties={properties} onPropertiesChange={() => void load()} />}
            {tab === 'incidents' && <IncidentsTab incidents={incidents} properties={properties} onIncidentsChange={() => void load()} />}
            {tab === 'approvals' && <ApprovalsPanel />}
            {tab === 'vendors' && <VendorsTab />}
          </>
        )}
      </div>
    </main>
  );
}
