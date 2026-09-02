import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const LIST_PROPERTIES_TOOL_NAME = 'list_properties';

/**
 * READ-tier: a plain list from PropertyOperationsRepository.listProperties,
 * the same real backend PropertyOperationsPage.tsx's Overview tab already
 * uses - no new data model, just a new caller. Only offered to the model
 * when the business actually has at least one property row (see
 * hasPropertyData in aiContextGathererService.ts), so a non-property
 * business's agent is never handed a tool that would just return an empty
 * list every time.
 */
export const listPropertiesFunctionDeclaration: FunctionDeclaration = {
  name: LIST_PROPERTIES_TOOL_NAME,
  description:
    "Lists this business's real properties (name, address, city, type, status). Use this to answer questions like " +
    '"what properties do you manage" or "do you have anything in [area]" - never invent a property that is not in ' +
    'this list. Takes no arguments.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};
