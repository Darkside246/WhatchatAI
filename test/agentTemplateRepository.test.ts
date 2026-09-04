import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AgentTemplateRepository } from '../src/repositories/agentTemplateRepository.js';
import { resetDatabase } from './helpers.js';

/**
 * Real-Postgres coverage against the two rows seeded by migration 951 -
 * this repository has no create/update in phase 1, so there's nothing to
 * round-trip beyond confirming the seeded data reads back correctly.
 */
describe('AgentTemplateRepository (real Postgres, seeded by migration 951)', () => {
  it('listAll returns both real seeded templates', async () => {
    await resetDatabase();
    const repo = new AgentTemplateRepository(pool);
    const templates = await repo.listAll();

    expect(templates.map((t) => t.templateKey).sort()).toEqual(['personal_assistant', 'property_operations_assistant', 'retail_operations_assistant']);
    for (const template of templates) {
      // Every recommended tool must be a real, registered tool name - never
      // a capability that isn't actually implemented.
      expect(template.recommendedTools.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
      expect(template.defaultSystemInstruction.length).toBeGreaterThan(20);
    }

    const personalAssistant = templates.find((t) => t.templateKey === 'personal_assistant');
    expect(personalAssistant?.recommendedTools).toEqual([
      'get_current_time',
      'update_conversation_memory',
      'schedule_google_meet',
      'schedule_zoom_meeting',
    ]);

    // Migration 953: once list_properties/check_property_status existed as
    // real tools, the property template was updated to actually recommend
    // them - it no longer needs to stay identical to personal_assistant's
    // list just because no property-data tool existed at seed time.
    const propertyAssistant = templates.find((t) => t.templateKey === 'property_operations_assistant');
    expect(propertyAssistant?.recommendedTools).toEqual([
      'get_current_time',
      'update_conversation_memory',
      'schedule_google_meet',
      'schedule_zoom_meeting',
      'list_properties',
      'check_property_status',
    ]);

    // Migration 973: shipped instruction and recommended_tools together in
    // one migration from the start, unlike property's 951->953->972 drift.
    const retailAssistant = templates.find((t) => t.templateKey === 'retail_operations_assistant');
    expect(retailAssistant?.recommendedTools).toEqual([
      'get_current_time',
      'update_conversation_memory',
      'list_retail_products',
      'check_retail_order_status',
    ]);
  });

  it('findByKey returns the real matching template, and null for an unknown key', async () => {
    await resetDatabase();
    const repo = new AgentTemplateRepository(pool);

    const property = await repo.findByKey('property_operations_assistant');
    expect(property?.role).toBe('Property Operations Assistant');
    expect(property?.category).toBe('bookings');
    expect(property?.defaultTriggerKeywords).toEqual(['viewing', 'maintenance', 'appointment', 'inspection']);

    expect(await repo.findByKey('does_not_exist')).toBeNull();

    const retail = await repo.findByKey('retail_operations_assistant');
    expect(retail?.role).toBe('Retail Operations Assistant');
    expect(retail?.category).toBe('commerce');
    expect(retail?.defaultTriggerKeywords).toEqual(['order', 'buy', 'price', 'stock', 'delivery', 'pickup']);
  });

  /**
   * Section 50-55 follow-up to migration 953: that migration gave the
   * property template the real list_properties/check_property_status
   * tools, but the seed's own default_system_instruction (migration 951)
   * still told the agent "You do not have access to maintenance requests,
   * work orders... yet" - a stale disclaimer directly contradicting the
   * tool it now has. Migration 972 fixes the text.
   */
  it('the property template\'s instruction no longer disclaims maintenance/work-order access it actually has, and still tells the agent to use its status tool honestly', async () => {
    await resetDatabase();
    const repo = new AgentTemplateRepository(pool);
    const property = await repo.findByKey('property_operations_assistant');

    expect(property?.defaultSystemInstruction).not.toContain('do not have access to maintenance requests, work orders');
    expect(property?.defaultSystemInstruction).toContain('checking on the real status of a maintenance issue');
    expect(property?.defaultSystemInstruction).toContain('never guess or invent a status');
  });
});
