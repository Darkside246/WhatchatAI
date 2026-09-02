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

  async listAll(): Promise<AgentTemplateRecord[]> {
    const { rows } = await this.db.query<AgentTemplateRow>('SELECT * FROM agent_templates ORDER BY created_at ASC');
    return rows.map(toRecord);
  }

  async findByKey(templateKey: string): Promise<AgentTemplateRecord | null> {
    const { rows } = await this.db.query<AgentTemplateRow>('SELECT * FROM agent_templates WHERE template_key = $1', [templateKey]);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
