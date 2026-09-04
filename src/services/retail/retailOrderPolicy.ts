import { z } from 'zod';

export const RetailOrderClassificationSchema = z.object({
  category: z.enum(['GENERAL_INQUIRY', 'PRICE_CHECK', 'STOCK_CHECK', 'NEW_ORDER', 'ORDER_STATUS', 'ORDER_CHANGE', 'COMPLAINT']),
  urgency: z.enum(['ROUTINE', 'PRIORITY', 'ESCALATE']),
  humanEscalationRequired: z.boolean(),
  matchedRiskSignals: z.array(z.string()),
  recommendedNextStep: z.enum(['REQUEST_PRODUCT_DETAILS', 'CREATE_ORDER', 'ESCALATE_HUMAN']),
  clarificationQuestions: z.array(z.string()).max(5),
});
export type RetailOrderClassification = z.infer<typeof RetailOrderClassificationSchema>;

/**
 * Deterministic risk signals are retail's analogue to property's emergency
 * regexes, but there is no life-safety equivalent here - the signals below
 * exist to short-circuit fraud/abuse/dispute situations before they reach
 * the AI or, worse, get auto-approved. Deliberately conservative and small:
 * padding this list to "look" as thorough as property's would be dishonest
 * about what retail actually needs to guard against.
 */
const riskSignals: Array<{ label: string; pattern: RegExp }> = [
  { label: 'payment_dispute', pattern: /\b(chargeback|dispute(?:d)?\s+(?:the\s+)?(?:charge|payment)|fraud(?:ulent)?\s+(?:charge|transaction)|never\s+authorized)\b/i },
  { label: 'refund_demand', pattern: /\b(refund|money\s+back|reverse\s+the\s+charge|charge\s+me\s+back)\b/i },
  { label: 'repeat_complaint', pattern: /\b(again|still\s+(?:hasn'?t|has\s+not|not)\s+(?:arrived|resolved|fixed)|third\s+time|keep\s+telling\s+you)\b/i },
  { label: 'threatening_language', pattern: /\b(lawyer|legal\s+action|sue|report\s+you|police)\b/i },
];

const categoryRules: Array<[RetailOrderClassification['category'], RegExp]> = [
  ['COMPLAINT', /\b(complain(?:t)?|broken|damaged|wrong\s+item|not\s+what\s+i\s+ordered|missing\s+item)\b/i],
  ['ORDER_STATUS', /\b(where\s+is\s+my\s+order|track(?:ing)?|order\s+status|has\s+it\s+shipped|when\s+will\s+(?:it|my\s+order)\s+arrive)\b/i],
  ['ORDER_CHANGE', /\b(cancel\s+(?:my\s+)?order|change\s+(?:my\s+)?order|modify\s+(?:my\s+)?order)\b/i],
  ['STOCK_CHECK', /\b(in\s+stock|available|do\s+you\s+have|out\s+of\s+stock)\b/i],
  ['PRICE_CHECK', /\b(how\s+much|price|cost|pricing)\b/i],
  ['NEW_ORDER', /\b(i\s*(?:'d|would)?\s*like\s+to\s+(?:order|buy)|i\s+want\s+to\s+(?:order|buy)|place\s+an\s+order|order\s+\d)\b/i],
];

function normaliseInput(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function classifyRetailMessage(text: string): RetailOrderClassification {
  const input = normaliseInput(text);
  const matchedRiskSignals = riskSignals.filter(({ pattern }) => pattern.test(input)).map(({ label }) => label);

  if (matchedRiskSignals.length > 0) {
    return {
      category: 'COMPLAINT',
      urgency: 'ESCALATE',
      humanEscalationRequired: true,
      matchedRiskSignals,
      recommendedNextStep: 'ESCALATE_HUMAN',
      clarificationQuestions: [],
    };
  }

  const category = categoryRules.find(([, pattern]) => pattern.test(input))?.[0] ?? 'GENERAL_INQUIRY';

  if (category === 'NEW_ORDER') {
    return {
      category,
      urgency: 'ROUTINE',
      humanEscalationRequired: false,
      matchedRiskSignals,
      recommendedNextStep: 'CREATE_ORDER',
      clarificationQuestions: [],
    };
  }

  if (category === 'ORDER_STATUS' || category === 'ORDER_CHANGE') {
    return {
      category,
      urgency: 'PRIORITY',
      humanEscalationRequired: category === 'ORDER_CHANGE',
      matchedRiskSignals,
      recommendedNextStep: category === 'ORDER_CHANGE' ? 'ESCALATE_HUMAN' : 'REQUEST_PRODUCT_DETAILS',
      clarificationQuestions: category === 'ORDER_CHANGE' ? [] : ['Can you share the order number or the name/phone used when ordering?'],
    };
  }

  return {
    category,
    urgency: 'ROUTINE',
    humanEscalationRequired: false,
    matchedRiskSignals,
    recommendedNextStep: 'REQUEST_PRODUCT_DETAILS',
    clarificationQuestions: [],
  };
}
