import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const CHECK_PROPERTY_STATUS_TOOL_NAME = 'check_property_status';

/**
 * READ-tier: reports real open incidents and their work order status for a
 * property. Deliberately read-only: for a chat an operator has bound to a
 * property, new incidents already go through the dedicated triage/approval
 * pipeline (propertyMaintenanceOrchestrator.ts's runPropertyMaintenanceHandoff,
 * which runs before this conversational path even sees the message) - this
 * tool exists for the other case, an unbound chat asking "what's the status
 * of what I already reported."
 *
 * Scoping (Section 75-91 privacy safeguard, see aiReplyService.ts's
 * executeOneToolCall): when the chat has a property_conversation_bindings
 * row, that bound property is the ONLY one this tool will ever report on -
 * the propertyReference argument below is ignored in that case. Only an
 * unbound chat falls back to resolving propertyReference via
 * PropertyOperationsRepository.findPropertiesByNameForBusiness (the same
 * ILIKE lookup Operator Mode's "note for [property]: ..." command uses),
 * which is scoped to the business, not to any one customer - never widen a
 * bound chat's scope with this free-text fallback, or one tenant's chat can
 * read back another tenant's real incident details just by naming their
 * address.
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
