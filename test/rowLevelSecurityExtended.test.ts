import { beforeEach, describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

// Migration 958 extends the migration-944 RLS backstop from 4 tables to
// every other real tenant-scoped table. This proves the database itself -
// not just application code - refuses to return another tenant's rows on a
// representative sample spanning the different areas the migration
// touches: security data, billing, property operations, and observability.
// No application code routes these specific tables through queryAsTenant()
// yet (only aiContextGathererService.ts and agentRoutingService.ts do,
// against the migration-944 tables) - this test exercises the policy
// directly, proving the backstop is real and ready for the first caller
// that needs it, independent of whether anything uses it today.
describe('Row-Level Security, extended tables (migration 958, real Postgres)', () => {
  let businessA: string;
  let businessB: string;

  beforeEach(async () => {
    await resetDatabase();
    businessA = await createTestBusiness('RLS Tenant A');
    businessB = await createTestBusiness('RLS Tenant B');
  });

  it('security_audit_logs: the tenant role only ever sees its own business\' rows', async () => {
    await pool.query(
      `INSERT INTO security_audit_logs (business_id, event_type, severity) VALUES ($1, 'sentinel_pass', 'info')`,
      [businessA],
    );
    await pool.query(
      `INSERT INTO security_audit_logs (business_id, event_type, severity) VALUES ($1, 'sentinel_pass', 'info')`,
      [businessB],
    );

    const { rows } = await queryAsTenant(businessA).query('SELECT business_id FROM security_audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.business_id).toBe(businessA);
  });

  it('invoices: a real invoice from another tenant is invisible under the tenant role', async () => {
    await pool.query(
      `INSERT INTO invoices (business_id, invoice_number) VALUES ($1, 'INV-A-1')`,
      [businessA],
    );
    await pool.query(
      `INSERT INTO invoices (business_id, invoice_number) VALUES ($1, 'INV-B-1')`,
      [businessB],
    );

    const { rows } = await queryAsTenant(businessB).query('SELECT invoice_number FROM invoices');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoice_number).toBe('INV-B-1');
  });

  it('property_properties: property-operations data is isolated the same way', async () => {
    await pool.query(`INSERT INTO property_properties (business_id, name) VALUES ($1, 'Sunset Villas')`, [businessA]);
    await pool.query(`INSERT INTO property_properties (business_id, name) VALUES ($1, 'Ocean View Complex')`, [businessB]);

    const { rows } = await queryAsTenant(businessA).query('SELECT name FROM property_properties');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Sunset Villas');
  });

  it('ai_usage_events: real AI telemetry is isolated the same way', async () => {
    await pool.query(
      `INSERT INTO ai_usage_events (business_id, model, call_kind) VALUES ($1, 'gemini-2.0-flash', 'primary')`,
      [businessA],
    );
    await pool.query(
      `INSERT INTO ai_usage_events (business_id, model, call_kind) VALUES ($1, 'gemini-2.0-flash', 'primary')`,
      [businessB],
    );

    const { rows } = await queryAsTenant(businessB).query('SELECT business_id FROM ai_usage_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.business_id).toBe(businessB);
  });

  it('customer_memory (migration 960): a customer\'s durable facts are isolated by business, not just by customer_id', async () => {
    const customerA = (await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessA])).rows[0]!.id;
    const customerB = (await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessB])).rows[0]!.id;
    await pool.query(`INSERT INTO customer_memory (business_id, customer_id, confirmed_facts) VALUES ($1, $2, '[{"key":"unit","value":"A-only"}]'::jsonb)`, [businessA, customerA]);
    await pool.query(`INSERT INTO customer_memory (business_id, customer_id, confirmed_facts) VALUES ($1, $2, '[{"key":"unit","value":"B-only"}]'::jsonb)`, [businessB, customerB]);

    const { rows } = await queryAsTenant(businessB).query<{ customer_id: string }>('SELECT customer_id FROM customer_memory');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customer_id).toBe(customerB);
  });

  it('with no tenant context set, the tenant role sees nothing (fails closed, never open)', async () => {
    await pool.query(
      `INSERT INTO security_audit_logs (business_id, event_type, severity) VALUES ($1, 'sentinel_pass', 'info')`,
      [businessA],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE whatchatai_tenant');
      // Deliberately no set_config('app.current_business_id', ...) call.
      const { rows } = await client.query('SELECT * FROM security_audit_logs');
      expect(rows).toHaveLength(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
