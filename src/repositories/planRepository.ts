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
}
