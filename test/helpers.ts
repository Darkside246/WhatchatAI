import { pool } from '../src/db/pool.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { SubscriptionRepository } from '../src/repositories/subscriptionRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';

const TABLES = [
  // No FK to anything by design (see migration 936) - a real
  // TRUNCATE ... CASCADE from any other table in this list never reaches
  // it, so it needs its own explicit entry to be cleared between tests.
  'trial_phone_fingerprints',
  // Consent happens before a business exists (public landing page), so
  // user_consents has no FK to businesses either - same reasoning as
  // above. consent_confirmations cascades from it (ON DELETE CASCADE).
  'user_consents',
  'business_document_versions',
  'business_documents',
  'openclaw_tool_executions',
  'openclaw_security_advisories',
  'openclaw_security_watcher_runs',
  'openclaw_cells',
  'ai_agent_prompt_optimizations',
  'funnel_instances',
  'funnel_steps',
  'funnel_definitions',
  'scheduled_statuses',
  'campaign_recipients',
  'campaigns',
  'agent_capacity',
  'team_members',
  'teams',
  'notifications',
  'auth_login_attempts',
  'sessions',
  'user_preferences',
  'business_memberships',
  'users',
  'conversation_events',
  'conversation_states',
  'customer_identities',
  'customers',
  'whatsapp_jid_mappings',
  'whatsapp_sync_jobs',
  'whatsapp_connection_events',
  'whatsapp_statuses',
  'whatsapp_calls',
  'whatsapp_presence',
  'whatsapp_message_reactions',
  'whatsapp_media',
  'whatsapp_outbound_messages',
  'whatsapp_messages',
  'whatsapp_chats',
  'whatsapp_group_members',
  'whatsapp_groups',
  'whatsapp_contacts',
  'whatsapp_accounts',
  'leads',
  'crm_contacts',
  'usage_counters',
  'subscription_events',
  'subscriptions',
  'ai_agents',
  'businesses',
  // NOTE: 'plans' and 'plan_entitlements' are intentionally NOT truncated -
  // they are seeded reference/product-configuration data (Phase 2C SaaS
  // foundation), not per-test state.
];

export async function resetDatabase(): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function createTestBusiness(name = 'Test Business'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO businesses (name) VALUES ($1) RETURNING id', [name]);
  const row = rows[0];
  if (!row) throw new Error('failed to create test business');
  return row.id;
}

export async function createTestAccount(businessId: string, jid = '15550001111@s.whatsapp.net'): Promise<string> {
  const accountRepository = new WhatsAppAccountRepository(pool);
  const account = await accountRepository.upsertConnected({
    businessId,
    whatsappJid: jid,
    jidKind: 'individual',
    phoneNumber: `+${jid.split('@')[0]}`,
    pushName: 'Test Account',
    connectionStatus: 'CONNECTED',
  });
  return account.id;
}

export async function createTestSubscription(businessId: string, planKey = 'starter'): Promise<string> {
  const planRepository = new PlanRepository(pool);
  const plan = await planRepository.findByKey(planKey);
  if (!plan) throw new Error(`Seed plan "${planKey}" not found - did migrations run?`);

  const subscriptionRepository = new SubscriptionRepository(pool);
  const subscription = await subscriptionRepository.ensureDefault(businessId, plan.id);
  return subscription.id;
}

/**
 * A real users row + real business_memberships row, bypassing
 * register()'s single-default-business provisioning gate - useful when
 * a test needs a second, genuinely distinct user/business pair within
 * one test case (register() only ever succeeds once per resetDatabase()
 * call). Password fields are structural fixtures only - this user is
 * never authenticated through, only referenced as a real FK target.
 */
export async function createTestUser(businessId: string, email = `test-user-${Math.random().toString(36).slice(2)}@example.com`): Promise<string> {
  const userRepository = new UserRepository(pool);
  const user = await userRepository.create({
    email,
    displayName: 'Test User',
    passwordHash: 'test-fixture-hash',
    passwordSalt: 'test-fixture-salt',
    passwordParams: { memoryCostKib: 19_456, timeCost: 3, parallelism: 1, hashLengthBytes: 32 },
  });
  await pool.query(`INSERT INTO business_memberships (business_id, user_id, role, status) VALUES ($1, $2, 'OWNER', 'active')`, [
    businessId,
    user.id,
  ]);
  return user.id;
}

/**
 * (b)-schema equivalent of createTestSubscription - no such fixture
 * existed before, every test needing a product_accounts row built one
 * inline via registerTrial(). product_catalog is real seed data
 * (migration 926) and, like plans, is deliberately excluded from
 * resetDatabase()'s truncation list above.
 */
/**
 * product_accounts_owner_or_provisioning_check (migration 909) requires
 * a non-null owner_user_id for any status other than PROVISIONING, so
 * this needs a real user id - pass one from createTestUser().
 */
export async function createTestProductAccount(businessId: string, ownerUserId: string, productKey = 'property'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM product_catalog WHERE product_key = $1', [productKey]);
  const productId = rows[0]?.id;
  if (!productId) throw new Error(`Seed product_catalog row "${productKey}" not found - did migrations run?`);
  const account = await pool.query<{ id: string }>(
    `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name) VALUES ($1, $2, $3, 'ACTIVE', 'Test Product Account') RETURNING id`,
    [businessId, productId, ownerUserId],
  );
  const row = account.rows[0];
  if (!row) throw new Error('failed to create test product account');
  return row.id;
}

export { pool };
export { BusinessRepository };
