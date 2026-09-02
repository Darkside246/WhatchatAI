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

    expect(templates.map((t) => t.templateKey).sort()).toEqual(['personal_assistant', 'property_operations_assistant']);
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
  });

  it('findByKey returns the real matching template, and null for an unknown key', async () => {
    await resetDatabase();
    const repo = new AgentTemplateRepository(pool);

    const property = await repo.findByKey('property_operations_assistant');
    expect(property?.role).toBe('Property Operations Assistant');
    expect(property?.category).toBe('bookings');
    expect(property?.defaultTriggerKeywords).toEqual(['viewing', 'maintenance', 'appointment', 'inspection']);

    expect(await repo.findByKey('does_not_exist')).toBeNull();
  });
});
