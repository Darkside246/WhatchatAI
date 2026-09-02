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
      // Both templates recommend only real, registered tool names - never a
      // capability that isn't actually implemented (no property-data tool
      // exists yet, so both lists must be identical today).
      expect(template.recommendedTools).toEqual([
        'get_current_time',
        'update_conversation_memory',
        'schedule_google_meet',
        'schedule_zoom_meeting',
      ]);
      expect(template.defaultSystemInstruction.length).toBeGreaterThan(20);
    }
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
