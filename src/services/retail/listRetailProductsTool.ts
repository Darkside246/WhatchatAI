import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const LIST_RETAIL_PRODUCTS_TOOL_NAME = 'list_retail_products';

/**
 * READ-tier: a plain list from RetailOperationsRepository.listProducts, the
 * same real backend RetailOperationsPage.tsx's Products tab already uses -
 * no new data model, just a new caller. Only offered to the model when the
 * business actually has at least one product row (see hasRetailData in
 * aiContextGathererService.ts), so a non-retail business's agent is never
 * handed a tool that would just return an empty list every time.
 */
export const listRetailProductsFunctionDeclaration: FunctionDeclaration = {
  name: LIST_RETAIL_PRODUCTS_TOOL_NAME,
  description:
    "Lists this business's real products (name, category, price, stock status). Use this to answer questions like " +
    '"what do you sell" or "do you have [item]" - never invent a product that is not in this list. Takes no arguments.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};
