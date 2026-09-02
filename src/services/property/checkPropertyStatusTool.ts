import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const CHECK_PROPERTY_STATUS_TOOL_NAME = 'check_property_status';

/**
 * READ-tier: resolves a customer's free-text property reference (a name or
 * address fragment, not a UUID the customer would never have) via
 * PropertyOperationsRepository.findPropertiesByNameForBusiness - the same
 * ILIKE lookup Operator Mode's "note for [property]: ..." command already
 * uses - then reports real open incidents and their work order status.
 * Deliberately read-only: for a chat an operator has bound to a property,
 * new incidents already go through the dedicated triage/approval pipeline
 * (propertyMaintenanceOrchestrator.ts's runPropertyMaintenanceHandoff,
 * which runs before this conversational path even sees the message) -
 * this tool exists for the other case, an unbound chat asking "what's the
 * status of what I already reported."
 */
export const checkPropertyStatusFunctionDeclaration: FunctionDeclaration = {
  name: CHECK_PROPERTY_STATUS_TOOL_NAME,
  description:
    'Looks up a real property by name or address (as the customer described it, not an internal ID) and reports its ' +
    'open maintenance incidents and their work order status. Use this to answer "any update on the issue I reported" ' +
    'or "what is the status of [property]". If no property matches, or more than one does, this tool tells you so - ' +
    'ask the customer to clarify rather than guessing which property they mean.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      propertyReference: {
        type: Type.STRING,
        description: "The property name or address the customer used, e.g. \"123 Main St\" or \"the Oakwood building\". Required.",
      },
    },
    required: ['propertyReference'],
  },
};

export interface CheckPropertyStatusToolArgs {
  propertyReference: string;
}
