import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, ChevronRight, Plus, RefreshCw, Wrench } from 'lucide-react';

type Property = { id: string; name: string; propertyType: string; status: string; city: string | null; countryCode: string | null };
type Incident = { id: string; title: string; category: string; severity: string; status: string; createdAt: string; aiSummary: string | null };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/property-operations${path}`, { ...options, credentials: 'include', headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  return payload as T;
}

export function PropertyOperationsPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [propertyData, incidentData] = await Promise.all([
        api<{ properties: Property[] }>('/properties'),
        api<{ incidents: Incident[] }>('/incidents'),
      ]);
      setProperties(propertyData.properties);
      setIncidents(incidentData.incidents);
      setSelectedProperty((current) => current ?? propertyData.properties[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load property operations');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const visibleIncidents = useMemo(() => selectedProperty ? incidents.filter((incident) => (incident as Incident & { propertyId?: string }).propertyId === selectedProperty || !('propertyId' in incident)) : incidents, [incidents, selectedProperty]);
  const emergencyCount = incidents.filter((incident) => incident.severity === 'EMERGENCY').length;
  const openCount = incidents.filter((incident) => !['RESOLVED', 'CLOSED'].includes(incident.status)).length;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface-0 p-5">
      <div className="mx-auto w-full max-w-7xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-meta uppercase tracking-wider text-fg-muted">Operations</p><h1 className="mt-1 text-2xl font-semibold text-fg">Property Operations</h1><p className="mt-1 text-caption text-fg-muted">One operational view for properties, assets, incidents and vendors.</p></div>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg hover:bg-surface-2"><RefreshCw size={15} /> Refresh</button>
        </div>

        {error && <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-4 text-caption text-danger">{error}</div>}

        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Metric icon={Building2} label="Properties" value={properties.length} />
          <Metric icon={Wrench} label="Open incidents" value={openCount} />
          <Metric icon={AlertTriangle} label="Emergency" value={emergencyCount} danger />
        </div>

        <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="rounded-xl border border-border-subtle bg-surface-1">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3"><h2 className="text-sm font-medium text-fg">Properties</h2><button className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2" title="Add property"><Plus size={16} /></button></div>
            <div className="p-2">{loading && <p className="px-3 py-4 text-caption text-fg-muted">Loading…</p>}{!loading && properties.length === 0 && <p className="px-3 py-4 text-caption text-fg-muted">No properties yet.</p>}{properties.map((property) => <button key={property.id} type="button" onClick={() => setSelectedProperty(property.id)} className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left ${selectedProperty === property.id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}><span><span className="block text-caption font-medium">{property.name}</span><span className="block text-meta text-fg-muted">{property.propertyType}{property.city ? ` · ${property.city}` : ''}</span></span><ChevronRight size={15} /></button>)}</div>
          </section>

          <section className="rounded-xl border border-border-subtle bg-surface-1">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3"><h2 className="text-sm font-medium text-fg">Maintenance incidents</h2><span className="rounded-full bg-surface-2 px-2 py-1 text-meta text-fg-muted">{visibleIncidents.length}</span></div>
            <div className="divide-y divide-border-subtle">{visibleIncidents.length === 0 && <p className="px-4 py-8 text-center text-caption text-fg-muted">No incidents for this view.</p>}{visibleIncidents.map((incident) => <div key={incident.id} className="flex items-start gap-3 px-4 py-4"><div className="mt-0.5 rounded-lg bg-surface-2 p-2"><Wrench size={16} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-caption font-medium text-fg">{incident.title}</h3><Badge label={incident.severity} danger={incident.severity === 'EMERGENCY'} /><Badge label={incident.status} /></div><p className="mt-1 text-meta text-fg-muted">{incident.category} · {new Date(incident.createdAt).toLocaleString()}</p>{incident.aiSummary && <p className="mt-2 text-caption text-fg-secondary">{incident.aiSummary}</p>}</div></div>)}</div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Metric({ icon: Icon, label, value, danger = false }: { icon: typeof Building2; label: string; value: number; danger?: boolean }) { return <div className="rounded-xl border border-border-subtle bg-surface-1 p-4"><div className="flex items-center gap-2 text-meta text-fg-muted"><Icon size={15} />{label}</div><div className={`mt-2 text-2xl font-semibold ${danger ? 'text-danger' : 'text-fg'}`}>{value}</div></div>; }
function Badge({ label, danger = false }: { label: string; danger?: boolean }) { return <span className={`rounded-full px-2 py-0.5 text-[11px] ${danger ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-fg-muted'}`}>{label}</span>; }
