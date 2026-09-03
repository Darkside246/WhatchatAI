import type { Queryable } from './types.js';

export interface PlanRecord {
  id: string;
  planKey: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number | null;
  currency: string;
  isActive: boolean;
}

export interface PlanEntitlementRecord {
  id: string;
  planId: string;
  entitlementKey: string;
  limitValue: number | null;
  isEnabled: boolean;
}

interface PlanRow {
  id: string;
  plan_key: string;
  name: string;
  description: string | null;
  price_monthly_cents: number;
  price_yearly_cents: number | null;
  currency: string;
  is_active: boolean;
}

interface PlanEntitlementRow {
  id: string;
  plan_id: string;
  entitlement_key: string;
  limit_value: string | null;
  is_enabled: boolean;
}

function toPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    planKey: row.plan_key,
    name: row.name,
    description: row.description,
    priceMonthlyCents: row.price_monthly_cents,
    priceYearlyCents: row.price_yearly_cents,
    currency: row.currency,
    isActive: row.is_active,
  };
}

function toEntitlement(row: PlanEntitlementRow): PlanEntitlementRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    entitlementKey: row.entitlement_key,
    limitValue: row.limit_value === null ? null : Number(row.limit_value),
    isEnabled: row.is_enabled,
  };
}

export class PlanRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<PlanRecord | null> {
    const { rows } = await this.db.query<PlanRow>('SELECT * FROM plans WHERE id = $1', [id]);
    return rows[0] ? toPlan(rows[0]) : null;
  }

  async findByKey(planKey: string): Promise<PlanRecord | null> {
    const { rows } = await this.db.query<PlanRow>('SELECT * FROM plans WHERE plan_key = $1 AND is_active = true', [
      planKey,
    ]);
    return rows[0] ? toPlan(rows[0]) : null;
  }

  async listActive(): Promise<PlanRecord[]> {
    const { rows } = await this.db.query<PlanRow>(
      'SELECT * FROM plans WHERE is_active = true ORDER BY price_monthly_cents',
    );
    return rows.map(toPlan);
  }

  async getEntitlement(planId: string, entitlementKey: string): Promise<PlanEntitlementRecord | null> {
    const { rows } = await this.db.query<PlanEntitlementRow>(
      'SELECT * FROM plan_entitlements WHERE plan_id = $1 AND entitlement_key = $2',
      [planId, entitlementKey],
    );
    return rows[0] ? toEntitlement(rows[0]) : null;
  }

  async listEntitlements(planId: string): Promise<PlanEntitlementRecord[]> {
    const { rows } = await this.db.query<PlanEntitlementRow>(
      'SELECT * FROM plan_entitlements WHERE plan_id = $1 ORDER BY entitlement_key',
      [planId],
    );
    return rows.map(toEntitlement);
  }

  /** Every plan, active or not - the developer control plane needs to see (and be able to re-enable) a retired plan, not just the ones customers can currently sign up for. */
  async listAll(): Promise<PlanRecord[]> {
    const { rows } = await this.db.query<PlanRow>('SELECT * FROM plans ORDER BY price_monthly_cents');
    return rows.map(toPlan);
  }

  /**
   * Real developer-editable pricing - before this, the "illustrative
   * starting values" migration 025's own comment promised ("the business
   * can change") were only ever changeable by hand-editing a migration.
   * Every field is optional so a caller can patch just the one thing
   * changed (e.g. only the price) without first re-reading and re-sending
   * the rest of the row.
   */
  async updatePlan(
    id: string,
    input: {
      name?: string | undefined;
      description?: string | null | undefined;
      priceMonthlyCents?: number | undefined;
      priceYearlyCents?: number | null | undefined;
      isActive?: boolean | undefined;
    },
  ): Promise<PlanRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) { values.push(input.name); sets.push(`name = $${values.length}`); }
    if (input.description !== undefined) { values.push(input.description); sets.push(`description = $${values.length}`); }
    if (input.priceMonthlyCents !== undefined) { values.push(input.priceMonthlyCents); sets.push(`price_monthly_cents = $${values.length}`); }
    if (input.priceYearlyCents !== undefined) { values.push(input.priceYearlyCents); sets.push(`price_yearly_cents = $${values.length}`); }
    if (input.isActive !== undefined) { values.push(input.isActive); sets.push(`is_active = $${values.length}`); }
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const { rows } = await this.db.query<PlanRow>(
      `UPDATE plans SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ? toPlan(rows[0]) : null;
  }

  /**
   * The one real write path for a plan's limits - a plan_id/entitlement_key
   * pair either already exists (edit it in place) or doesn't yet (a brand
   * new limit key introduced after the plan was created, e.g. a future
   * entitlement type) - both are the same real-world action from a
   * developer's point of view, so both go through the same call.
   * limitValue: null means unlimited for this plan, matching the column's
   * own documented meaning (018_create_plan_entitlements.sql) - never
   * confused with "not set at all".
   */
  async upsertEntitlement(planId: string, entitlementKey: string, input: { limitValue: number | null; isEnabled: boolean }): Promise<PlanEntitlementRecord> {
    const { rows } = await this.db.query<PlanEntitlementRow>(
      `INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (plan_id, entitlement_key) DO UPDATE SET limit_value = $3, is_enabled = $4, updated_at = now()
       RETURNING *`,
      [planId, entitlementKey, input.limitValue, input.isEnabled],
    );
    const row = rows[0];
    if (!row) throw new Error('plan_entitlements upsert returned no row');
    return toEntitlement(row);
  }
}
