import type { ModuleManifest } from './moduleRegistry.js';

/** Platform modules share the same runtime, graph, policy, action and audit primitives. */
export const MODULE_CATALOG: ModuleManifest[] = [
  {
    id: 'property.operations', version: '1.0.0', name: 'Property Operations',
    description: 'Property, villa, guest, maintenance and vendor operations.',
    entitlements: ['property.operations'], skillIds: ['property.maintenance.triage'], routePrefix: '/property-operations', enabledByDefault: false,
  },
  {
    id: 'voice.operations', version: '1.0.0', name: 'Voice Operations',
    description: 'Inbound call events, transcription and bounded voice workflows.',
    entitlements: ['voice.operations'], skillIds: [], routePrefix: '/voice-operations', enabledByDefault: false,
  },
  {
    id: 'document.operations', version: '1.0.0', name: 'Document Operations',
    description: 'Document ingestion, extraction, classification and workflow handoff.',
    entitlements: ['document.operations'], skillIds: [], routePrefix: '/document-operations', enabledByDefault: false,
  },
  {
    id: 'sales.operations', version: '1.0.0', name: 'Sales Operations',
    description: 'Lead intake, qualification, follow-up and appointment workflows.',
    entitlements: ['sales.operations'], skillIds: [], routePrefix: '/sales-operations', enabledByDefault: false,
  },
];
