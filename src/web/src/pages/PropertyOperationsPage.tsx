import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';

type Property = { id: string; name: string; propertyType: string; status: string; city: string | null; countryCode: string | null };
type Incident = { id: string; title: string; category: string; severity: string; status: string; createdAt: string; aiSummary: string | null; propertyId?: string };

type SeverityFilter = 'ALL' | 'EMERGENCY' | 'PRIORITY' | 'ROUTINE';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/property-operations${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  return payload as T;
}

export function PropertyOperationsPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<string | null>(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [propertyData, incidentData] = await Promise.all([
        api<{ properties: Property[] }>('/properties'),
        api<{ incidents: Incident[] }>('/incidents'),
      ]);
      setProperties(propertyData.properties);
      setIncidents(incidentData.incidents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load property operations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const emergencyCount = incidents.filter((incident) => incident.severity === 'EMERGENCY').length;
  const priorityCount = incidents.filter((incident) => incident.severity === 'PRIORITY').length;
  const openCount = incidents.filter((incident) => !['RESOLVED', 'CLOSED'].includes(incident.status)).length;

  const filteredIncidents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return incidents
      .filter((incident) => !selectedProperty || incident.propertyId === selectedProperty || !incident.propertyId)
      .filter((incident) => severityFilter === 'ALL' || incident.severity === severityFilter)
      .filter((incident) => !normalizedQuery || [incident.title, incident.category, incident.status, incident.severity, incident.aiSummary ?? ''].join(' ').toLowerCase().includes(normalizedQuery))
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [incidents, query, selectedProperty, severityFilter]);

  const criticalIncidents = useMemo(() => incidents.filter((incident) => incident.severity === 'EMERGENCY' && !['RESOLVED', 'CLOSED'].includes(incident.status)), [incidents]);
  const selectedIncident = useMemo(() => incidents.find((incident) => incident.id === selectedIncidentId) ?? filteredIncidents[0] ?? null, [filteredIncidents, incidents, selectedIncidentId]);

  useEffect(() => {
    if (selectedIncidentId && !filteredIncidents.some((incident) => incident.id === selectedIncidentId)) setSelectedIncidentId(null);
  }, [filteredIncidents, selectedIncidentId]);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface-0 p-5">
      <div className="mx-auto w-full max-w-[1600px]">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-meta uppercase tracking-[0.16em] text-fg-muted">Operations command centre</p>
            <h1 className="mt-1 text-2xl font-semibold text-fg">Property Operations</h1>
            <p className="mt-1 text-caption text-fg-muted">Triage urgent maintenance first, then manage the rest of your portfolio.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg hover:bg-surface-2">
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-danger/30 bg-danger/5 p-4 text-caption text-danger">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-danger/30 px-3 py-1.5 text-meta hover:bg-danger/10">Try again</button>
          </div>
        )}

        {criticalIncidents.length > 0 && (
          <section className="mb-5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger"><ShieldAlert size={18} /></span>
                <div className="min-w-0">
                  <p className="text-caption font-medium text-danger">{criticalIncidents.length} emergency {criticalIncidents.length === 1 ? 'incident requires' : 'incidents require'} attention</p>
                  <p className="truncate text-meta text-fg-muted">{criticalIncidents.slice(0, 2).map((incident) => incident.title).join(' · ')}</p>
                </div>
              </div>
              <button type="button" onClick={() => { setSeverityFilter('EMERGENCY'); setSelectedIncidentId(criticalIncidents[0]?.id ?? null); }} className="inline-flex items-center gap-2 rounded-lg bg-danger px-3 py-2 text-caption font-medium text-white">
                Review critical queue <ChevronRight size={15} />
              </button>
            </div>
          </section>
        )}

        <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={Building2} label="Properties" value={properties.length} />
          <Metric icon={Wrench} label="Open incidents" value={openCount} />
          <Metric icon={AlertTriangle} label="Priority" value={priorityCount} tone="warning" />
          <Metric icon={ShieldAlert} label="Emergency" value={emergencyCount} tone="danger" />
        </section>

        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
          <aside className="rounded-xl border border-border-subtle bg-surface-1 xl:sticky xl:top-0 xl:self-start">
            <div className="border-b border-border-subtle px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Triage queue</p>
            </div>
            <div className="space-y-1 p-2">
              <QueueButton active={severityFilter === 'ALL'} icon={Wrench} label="All incidents" count={incidents.length} onClick={() => setSeverityFilter('ALL')} />
              <QueueButton active={severityFilter === 'EMERGENCY'} icon={ShieldAlert} label="Emergency" count={emergencyCount} tone="danger" onClick={() => setSeverityFilter('EMERGENCY')} />
              <QueueButton active={severityFilter === 'PRIORITY'} icon={AlertTriangle} label="Priority" count={priorityCount} tone="warning" onClick={() => setSeverityFilter('PRIORITY')} />
              <QueueButton active={severityFilter === 'ROUTINE'} icon={CheckCircle2} label="Routine" count={incidents.filter((incident) => incident.severity === 'ROUTINE').length} onClick={() => setSeverityFilter('ROUTINE')} />
            </div>

            <div className="border-y border-border-subtle px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Properties</p>
            </div>
            <div className="max-h-[380px] overflow-auto p-2">
              <button type="button" onClick={() => setSelectedProperty(null)} className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ${selectedProperty === null ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
                <span className="text-caption font-medium">All properties</span><span className="text-meta text-fg-muted">{properties.length}</span>
              </button>
              {loading && <p className="px-3 py-4 text-caption text-fg-muted">Loading properties…</p>}
              {!loading && properties.length === 0 && <p className="px-3 py-4 text-caption text-fg-muted">No properties yet.</p>}
              {properties.map((property) => (
                <button key={property.id} type="button" onClick={() => setSelectedProperty(property.id)} className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ${selectedProperty === property.id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
                  <span className="min-w-0"><span className="block truncate text-caption font-medium">{property.name}</span><span className="block truncate text-meta text-fg-muted">{property.propertyType}{property.city ? ` · ${property.city}` : ''}</span></span><ChevronRight size={15} className="shrink-0" />
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 rounded-xl border border-border-subtle bg-surface-1">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-fg">Maintenance incidents</h2>
                <p className="mt-0.5 text-meta text-fg-muted">Urgent work is ranked first.</p>
              </div>
              <span className="rounded-full bg-surface-2 px-2 py-1 text-meta text-fg-muted">{filteredIncidents.length}</span>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
              <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-fg-muted focus-within:border-accent">
                <Search size={15} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search incidents" className="min-w-0 flex-1 bg-transparent text-caption text-fg outline-none placeholder:text-fg-muted" />
                {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
              </label>
              <button type="button" onClick={() => { setQuery(''); setSeverityFilter('ALL'); setSelectedProperty(null); }} className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-caption text-fg-muted hover:bg-surface-2"><Filter size={14} /> Clear filters</button>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[minmax(190px,1.2fr)_120px_105px_105px_minmax(180px,1.4fr)_40px] gap-3 border-b border-border-subtle bg-surface-2/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                  <span>Incident</span><span>Category</span><span>Urgency</span><span>Status</span><span>AI summary</span><span />
                </div>
                {loading && <p className="px-4 py-8 text-center text-caption text-fg-muted">Loading incidents…</p>}
                {!loading && filteredIncidents.length === 0 && <p className="px-4 py-12 text-center text-caption text-fg-muted">No incidents match this view.</p>}
                {filteredIncidents.map((incident) => (
                  <button key={incident.id} type="button" onClick={() => setSelectedIncidentId(incident.id)} className={`grid w-full grid-cols-[minmax(190px,1.2fr)_120px_105px_105px_minmax(180px,1.4fr)_40px] items-center gap-3 border-b border-border-subtle px-4 py-3 text-left transition hover:bg-surface-2/70 ${selectedIncident?.id === incident.id ? 'bg-accent-soft/60' : ''}`}>
                    <span className="min-w-0"><span className="block truncate text-caption font-medium text-fg">{incident.title}</span><span className="mt-1 block text-meta text-fg-muted">{formatDate(incident.createdAt)}</span></span>
                    <span className="truncate text-caption text-fg-secondary">{incident.category}</span>
                    <SeverityBadge label={incident.severity} />
                    <StatusBadge label={incident.status} />
                    <span className="line-clamp-2 text-caption text-fg-secondary">{incident.aiSummary || 'No AI summary available yet.'}</span>
                    <ChevronRight size={16} className="justify-self-end text-fg-muted" />
                  </button>
                ))}
              </div>
            </div>
          </section>

          <aside className="rounded-xl border border-border-subtle bg-surface-1 xl:sticky xl:top-0 xl:self-start">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <div><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Incident detail</p><h2 className="mt-1 text-caption font-medium text-fg">{selectedIncident ? selectedIncident.title : 'Select an incident'}</h2></div>
              {selectedIncident && <SeverityBadge label={selectedIncident.severity} />}
            </div>
            {!selectedIncident && <div className="px-4 py-10 text-center text-caption text-fg-muted">Choose an incident to review its operational details.</div>}
            {selectedIncident && (
              <div className="space-y-5 p-4">
                <div className="grid grid-cols-2 gap-3 text-meta">
                  <Detail label="Category" value={selectedIncident.category} />
                  <Detail label="Status" value={selectedIncident.status} />
                  <Detail label="Reported" value={formatDate(selectedIncident.createdAt)} />
                  <Detail label="Urgency" value={selectedIncident.severity} />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">AI summary</p>
                  <p className="mt-2 rounded-lg bg-surface-2 p-3 text-caption leading-6 text-fg-secondary">{selectedIncident.aiSummary || 'No AI summary is available for this incident yet.'}</p>
                </div>
                <div className="border-t border-border-subtle pt-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Operational actions</p>
                  <p className="text-caption leading-6 text-fg-muted">Actions are intentionally limited to the workflows currently available through the property operations backend. Additional assignment and escalation controls will be connected when their API actions are implemented.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function severityRank(severity: string) {
  if (severity === 'EMERGENCY') return 0;
  if (severity === 'PRIORITY') return 1;
  return 2;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Building2; label: string; value: number; tone?: 'danger' | 'warning' }) {
  const toneClass = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg';
  return <div className="rounded-xl border border-border-subtle bg-surface-1 p-4"><div className="flex items-center gap-2 text-meta text-fg-muted"><Icon size={15} />{label}</div><div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div></div>;
}

function QueueButton({ active, icon: Icon, label, count, tone, onClick }: { active: boolean; icon: typeof Wrench; label: string; count: number; tone?: 'danger' | 'warning'; onClick: () => void }) {
  const toneClass = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg-secondary';
  return <button type="button" onClick={onClick} className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left ${active ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}><span className="flex items-center gap-2 text-caption font-medium"><Icon size={15} className={active ? 'text-accent' : toneClass} />{label}</span><span className="text-meta text-fg-muted">{count}</span></button>;
}

function SeverityBadge({ label }: { label: string }) {
  const className = label === 'EMERGENCY' ? 'bg-danger/10 text-danger' : label === 'PRIORITY' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex w-fit rounded-full px-2 py-1 text-[11px] font-medium ${className}`}>{label}</span>;
}

function StatusBadge({ label }: { label: string }) {
  const className = ['RESOLVED', 'CLOSED'].includes(label) ? 'bg-success/10 text-success' : label === 'ESCALATED' ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex w-fit rounded-full px-2 py-1 text-[11px] font-medium ${className}`}>{label}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] text-fg-muted">{label}</p><p className="mt-1 truncate text-caption text-fg">{value}</p></div>;
}
