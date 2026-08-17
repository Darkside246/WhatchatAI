import { pool } from '../db/pool.js';

export type GlobalSearchResultType = 'chat' | 'contact' | 'lead' | 'campaign' | 'funnel';

export interface GlobalSearchResult {
  type: GlobalSearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
}

const RESULTS_PER_CATEGORY = 5;

/**
 * Real search across the entities a business actually has - never a
 * client-side filter over an already-loaded list, since chats/contacts/
 * leads/campaigns/funnels are each fetched separately by their own pages.
 * Every query is tenant-scoped by business_id and every match is a real
 * ILIKE against real column data, never a fabricated/ranked "AI search".
 */
export async function globalSearch(businessId: string, rawQuery: string): Promise<GlobalSearchResult[]> {
  const term = rawQuery.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;

  const [chats, contacts, leads, campaigns, funnels] = await Promise.all([
    pool.query<{ id: string; name: string | null; phone_number: string | null }>(
      `SELECT id, name, phone_number
         FROM whatsapp_chats
        WHERE business_id = $1 AND deleted_at IS NULL
          AND (name ILIKE $2 OR phone_number ILIKE $2)
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT $3`,
      [businessId, like, RESULTS_PER_CATEGORY],
    ),
    pool.query<{ id: string; display_name: string | null; phone_number: string | null; stage: string | null }>(
      `SELECT c.id, COALESCE(wc.display_name, wc.push_name, wc.verified_name) AS display_name, wc.phone_number, c.stage
         FROM crm_contacts c
         JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
        WHERE c.business_id = $1 AND c.deleted_at IS NULL
          AND (wc.display_name ILIKE $2 OR wc.push_name ILIKE $2 OR wc.verified_name ILIKE $2 OR wc.phone_number ILIKE $2)
        ORDER BY c.updated_at DESC
        LIMIT $3`,
      [businessId, like, RESULTS_PER_CATEGORY],
    ),
    pool.query<{ id: string; display_name: string | null; status: string }>(
      `SELECT l.id, COALESCE(wc.display_name, wc.push_name, wc.verified_name) AS display_name, l.status
         FROM leads l
         JOIN crm_contacts c ON c.id = l.crm_contact_id
         JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
        WHERE l.business_id = $1 AND l.deleted_at IS NULL
          AND (wc.display_name ILIKE $2 OR wc.push_name ILIKE $2 OR wc.verified_name ILIKE $2 OR l.next_action ILIKE $2)
        ORDER BY l.updated_at DESC
        LIMIT $3`,
      [businessId, like, RESULTS_PER_CATEGORY],
    ),
    pool.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status
         FROM campaigns
        WHERE business_id = $1 AND name ILIKE $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, like, RESULTS_PER_CATEGORY],
    ),
    pool.query<{ id: string; name: string; is_active: boolean }>(
      `SELECT id, name, is_active
         FROM funnel_definitions
        WHERE business_id = $1 AND name ILIKE $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, like, RESULTS_PER_CATEGORY],
    ),
  ]);

  const results: GlobalSearchResult[] = [];

  for (const row of chats.rows) {
    results.push({
      type: 'chat',
      id: row.id,
      title: row.name || row.phone_number || 'Unknown chat',
      subtitle: row.name ? row.phone_number : null,
      url: `/chats/${row.id}`,
    });
  }

  for (const row of contacts.rows) {
    results.push({
      type: 'contact',
      id: row.id,
      title: row.display_name || row.phone_number || 'Unknown contact',
      subtitle: row.stage,
      url: `/crm?tab=contacts&contactId=${row.id}`,
    });
  }

  for (const row of leads.rows) {
    results.push({
      type: 'lead',
      id: row.id,
      title: row.display_name || 'Unknown lead',
      subtitle: row.status,
      url: `/crm?tab=leads&leadId=${row.id}`,
    });
  }

  for (const row of campaigns.rows) {
    results.push({
      type: 'campaign',
      id: row.id,
      title: row.name,
      subtitle: row.status,
      url: `/marketing?tab=campaigns&campaignId=${row.id}`,
    });
  }

  for (const row of funnels.rows) {
    results.push({
      type: 'funnel',
      id: row.id,
      title: row.name,
      subtitle: row.is_active ? 'Active' : 'Inactive',
      url: `/automations?funnelId=${row.id}`,
    });
  }

  return results;
}
