import { pool } from '../src/db/pool.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { SubscriptionRepository } from '../src/repositories/subscriptionRepository.js';

const TABLES = [
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

export { pool };
export { BusinessRepository };
