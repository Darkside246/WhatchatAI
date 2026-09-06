import type { Queryable } from './types.js';
import type { AgentCategory } from './aiAgentRepository.js';

export interface AgentTemplateRecord {
  id: string;
  templateKey: string;
  name: string;
  role: string;
  description: string;
  category: AgentCategory;
  defaultPersona: string | null;
  defaultTone: string | null;
  defaultSystemInstruction: string;
  defaultGreeting: string | null;
  defaultTriggerKeywords: string[];
  /** Real tool names from aiToolPolicy.ts's registry - never a capability that isn't actually implemented. */
  recommendedTools: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface AgentTemplateRow {
  id: string;
  template_key: string;
  name: string;
  role: string;
  description: string;
  category: AgentCategory;
  default_persona: string | null;
  default_tone: string | null;
  default_system_instruction: string;
  default_greeting: string | null;
  default_trigger_keywords: string[];
  recommended_tools: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: AgentTemplateRow): AgentTemplateRecord {
  return {
    id: row.id,
    templateKey: row.template_key,
    name: row.name,
    role: row.role,
    description: row.description,
    category: row.category,
    defaultPersona: row.default_persona,
    defaultTone: row.default_tone,
    defaultSystemInstruction: row.default_system_instruction,
    defaultGreeting: row.default_greeting,
    defaultTriggerKeywords: row.default_trigger_keywords ?? [],
    recommendedTools: row.recommended_tools ?? [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** System-owned, read-only from the app's perspective in phase 1 - no create/update/delete yet, seeded directly by migration 951. */
export class AgentTemplateRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * callerEmail gates migration 1007's restricted_to_email column - a
   * template with a real value there is only ever returned to the account
   * whose email matches it (case-insensitive, same defensive posture as
   * this session's own earlier Google-OAuth-test-user casing bug). NULL
   * (the default for every pre-existing template) means visible to
   * everyone, unchanged from before this column existed.
   */
  async listAll(callerEmail?: string | null): Promise<AgentTemplateRecord[]> {
    const { rows } = await this.db.query<AgentTemplateRow>(
      'SELECT * FROM agent_templates WHERE restricted_to_email IS NULL OR LOWER(restricted_to_email) = LOWER($1) ORDER BY created_at ASC',
      [callerEmail ?? null],
    );
    return rows.map(toRecord);
  }

  /**
   * Same restriction enforced here too, not just in listAll() - hiding a
   * restricted template from the list alone would be UI cosmetics, not
   * real access control, since createAgentFromTemplate() resolves a
   * template directly by its known key.
   */
  async findByKey(templateKey: string, callerEmail?: string | null): Promise<AgentTemplateRecord | null> {
    const { rows } = await this.db.query<AgentTemplateRow>(
      'SELECT * FROM agent_templates WHERE template_key = $1 AND (restricted_to_email IS NULL OR LOWER(restricted_to_email) = LOWER($2))',
      [templateKey, callerEmail ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
