import type { Queryable } from './types.js';

export interface BusinessRecord {
  id: string;
  name: string;
}

/**
 * Bootstrap tenant repository. WhatchatAI's Authentication + Multi-Tenant phase
 * has not been built yet, so this ensures exactly one real business row exists
 * for single-tenant operation until that phase replaces it with real signup.
 */
export class BusinessRepository {
  constructor(private readonly db: Queryable) {}

  async ensureDefault(name = 'Default Business'): Promise<BusinessRecord> {
    const { rows } = await this.db.query<BusinessRecord>('SELECT id, name FROM businesses ORDER BY created_at LIMIT 1');
    if (rows[0]) return rows[0];

    const { rows: inserted } = await this.db.query<BusinessRecord>(
      'INSERT INTO businesses (name) VALUES ($1) RETURNING id, name',
      [name],
    );
    const row = inserted[0];
    if (!row) throw new Error('businesses insert returned no row');
    return row;
  }

  async findById(id: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRecord>('SELECT id, name FROM businesses WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async updateName(id: string, name: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRecord>(
      'UPDATE businesses SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name',
      [id, name],
    );
    return rows[0] ?? null;
  }
}
