import { describe, expect, it } from 'vitest';
import { OperationalGraphService } from './operationalGraphService.js';
import type { OperationalEntity } from '../../domain/platform/contracts.js';

const entity = (overrides: Partial<OperationalEntity> = {}): OperationalEntity => ({
  id: 'property-1', tenantId: 'tenant-1', type: 'PROPERTY', name: 'Villa Blue', attributes: {}, version: 1, updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
});

describe('OperationalGraphService', () => {
  it('stores and resolves a tenant-owned hierarchy', () => {
    const graph = new OperationalGraphService();
    graph.upsert(entity());
    graph.upsert(entity({ id: 'unit-1', type: 'UNIT', name: 'Master Suite', parentId: 'property-1' }));
    graph.upsert(entity({ id: 'asset-1', type: 'ASSET', name: 'Daikin AC', parentId: 'unit-1' }));

    expect(graph.listChildren('property-1', 'tenant-1').map((e) => e.id)).toEqual(['unit-1']);
    expect(graph.resolvePath('asset-1', 'tenant-1').map((e) => e.id)).toEqual(['property-1', 'unit-1', 'asset-1']);
  });

  it('hides another tenant\'s entities', () => {
    const graph = new OperationalGraphService();
    graph.upsert(entity({ id: 'property-1', tenantId: 'tenant-1' }));
    graph.upsert(entity({ id: 'property-2', tenantId: 'tenant-2' }));

    expect(graph.get('property-2', 'tenant-1')).toBeNull();
    expect(graph.findByType('PROPERTY', 'tenant-1').map((e) => e.id)).toEqual(['property-1']);
  });

  it('rejects cross-tenant parents and self-parenting', () => {
    const graph = new OperationalGraphService();
    graph.upsert(entity({ id: 'property-1', tenantId: 'tenant-1' }));
    graph.upsert(entity({ id: 'property-2', tenantId: 'tenant-2' }));

    expect(() => graph.upsert(entity({ id: 'unit-1', type: 'UNIT', parentId: 'property-2' }))).toThrow('different tenant');
    expect(() => graph.upsert(entity({ id: 'loop' , parentId: 'loop' }))).toThrow('does not exist');
  });

  it('prevents deleting an entity with children', () => {
    const graph = new OperationalGraphService();
    graph.upsert(entity());
    graph.upsert(entity({ id: 'unit-1', type: 'UNIT', name: 'Unit', parentId: 'property-1' }));
    expect(() => graph.remove('property-1', 'tenant-1')).toThrow('child entities');
  });
});
