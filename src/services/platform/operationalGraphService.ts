import { OperationalEntitySchema, type OperationalEntity } from '../../domain/platform/contracts.js';

export class OperationalGraphService {
  private readonly entities = new Map<string, OperationalEntity>();
  private readonly children = new Map<string, Set<string>>();

  upsert(entity: OperationalEntity): OperationalEntity {
    const parsed = OperationalEntitySchema.parse(entity);
    const existing = this.entities.get(parsed.id);

    if (existing?.tenantId !== parsed.tenantId) {
      throw new Error('operational graph tenant ownership cannot change');
    }

    if (parsed.parentId) {
      const parent = this.entities.get(parsed.parentId);
      if (!parent) throw new Error(`parent entity ${parsed.parentId} does not exist`);
      if (parent.tenantId !== parsed.tenantId) throw new Error('operational graph parent belongs to a different tenant');
      if (parent.id === parsed.id) throw new Error('operational graph entity cannot parent itself');
    }

    if (existing?.parentId && existing.parentId !== parsed.parentId) {
      this.removeChild(existing.parentId, existing.id);
    }
    if (parsed.parentId) {
      const siblings = this.children.get(parsed.parentId) ?? new Set<string>();
      siblings.add(parsed.id);
      this.children.set(parsed.parentId, siblings);
    }

    this.entities.set(parsed.id, parsed);
    return parsed;
  }

  get(id: string, tenantId: string): OperationalEntity | null {
    const entity = this.entities.get(id);
    if (!entity || entity.tenantId !== tenantId) return null;
    return entity;
  }

  listChildren(parentId: string, tenantId: string): OperationalEntity[] {
    const parent = this.get(parentId, tenantId);
    if (!parent) return [];
    return [...(this.children.get(parentId) ?? [])]
      .map((id) => this.entities.get(id))
      .filter((entity): entity is OperationalEntity => Boolean(entity && entity.tenantId === tenantId));
  }

  findByType(type: OperationalEntity['type'], tenantId: string): OperationalEntity[] {
    return [...this.entities.values()].filter((entity) => entity.tenantId === tenantId && entity.type === type);
  }

  resolvePath(id: string, tenantId: string): OperationalEntity[] {
    const path: OperationalEntity[] = [];
    const visited = new Set<string>();
    let current = this.get(id, tenantId);
    while (current) {
      if (visited.has(current.id)) throw new Error('operational graph cycle detected');
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId ? this.get(current.parentId, tenantId) : null;
    }
    return path;
  }

  remove(id: string, tenantId: string): boolean {
    const entity = this.get(id, tenantId);
    if (!entity) return false;
    if ((this.children.get(id)?.size ?? 0) > 0) throw new Error('cannot remove an entity with child entities');
    if (entity.parentId) this.removeChild(entity.parentId, entity.id);
    this.entities.delete(id);
    return true;
  }

  clear(): void {
    this.entities.clear();
    this.children.clear();
  }

  private removeChild(parentId: string, childId: string): void {
    const children = this.children.get(parentId);
    if (!children) return;
    children.delete(childId);
    if (children.size === 0) this.children.delete(parentId);
  }
}

export const operationalGraphService = new OperationalGraphService();
