import { z } from 'zod';

export const MaintenanceClassificationSchema = z.object({
  category: z.enum(['WATER', 'ELECTRICAL', 'HVAC', 'APPLIANCE', 'PLUMBING', 'STRUCTURAL', 'SECURITY', 'OTHER']),
  urgency: z.enum(['ROUTINE', 'PRIORITY', 'EMERGENCY']),
  humanEscalationRequired: z.boolean(),
  matchedSafetySignals: z.array(z.string()),
  recommendedNextStep: z.enum(['REQUEST_MEDIA', 'CREATE_WORK_ORDER', 'ESCALATE_HUMAN', 'CONTACT_EMERGENCY_SERVICE']),
  clarificationQuestions: z.array(z.string()).max(5),
});
export type MaintenanceClassification = z.infer<typeof MaintenanceClassificationSchema>;

/**
 * Deterministic safety signals are deliberately conservative. They are a
 * safety boundary, not a substitute for conversational understanding.
 * The wording accepts natural and informal WhatsApp-style phrasing.
 */
const emergencySignals: Array<{ label: string; pattern: RegExp }> = [
  { label: 'fire_or_smoke', pattern: /\b(fire|smoke|flame|burning\s+smell|smell\s+of\s+burning)\b/i },
  { label: 'gas_or_fuel', pattern: /\b(gas\s+(?:leak|smell)|smell\s+(?:of\s+)?gas|propane|fuel\s+leak)\b/i },
  { label: 'electrical_danger', pattern: /\b(sparking|sparks|exposed\s+wire|live\s+wire|electric\s+shock|electrical\s+fire|wire\s+is\s+burning)\b/i },
  {
    label: 'uncontrolled_water',
    pattern: /\b(flood(?:ing)?|water\s+(?:is\s+)?pouring|water\s+(?:is\s+)?coming\s+(?:in|through|down)|water\s+(?:is\s+)?running\s+(?:in|through|down)|water\s+(?:all\s+over|everywhere)|burst\s+pipe|pipe\s+(?:has\s+)?burst|pipe\s+done\s+burst|ceiling\s+(?:is\s+)?leaking\s+(?:bad|badly|heavily|a\s+lot)|water\s+coming\s+through\s+the\s+ceiling|water\s+coming\s+down\s+from\s+upstairs)\b/i,
  },
  { label: 'structural_collapse', pattern: /\b(ceiling|roof|wall|floor)\s+(?:is\s+)?collapsing|\b(structure|ceiling|roof|wall)\s+(?:has\s+)?collapsed\b/i },
  { label: 'security_threat', pattern: /\b(break\s*-?\s*in|intruder|armed|threatened|dangerous\s+person)\b/i },
  { label: 'sewage_or_wastewater', pattern: /\b(raw\s+sewage|sewage\s+(?:is\s+)?backing\s+up|sewage\s+overflow|wastewater\s+overflow)\b/i },
];

// Category rules describe the affected system, not necessarily the cause.
// Active uncontrolled-water signals take precedence over structural words such
// as "ceiling" because "water through the ceiling" is a water event.
const categoryRules: Array<[MaintenanceClassification['category'], RegExp]> = [
  ['ELECTRICAL', /\b(ac\s+power|breaker|circuit|electrical|outlet|socket|fuse|electric)\b/i],
  ['HVAC', /\b(ac|air\s+condition(?:er|ing)?|air-conditioning|thermostat|hvac|heat\s+pump|cooling|heat)\b/i],
  ['APPLIANCE', /\b(fridge|refrigerator|oven|stove|washer|dryer|dishwasher|microwave|appliance)\b/i],
  ['PLUMBING', /\b(toilet|loo|sink|drain|faucet|tap|shower|plumbing|pipe|clog(?:ged)?|blocked)\b/i],
  ['STRUCTURAL', /\b(ceiling|roof|wall|window|door\s+frame|foundation|structural)\b/i],
  ['SECURITY', /\b(lock|alarm|camera|key|intruder|security)\b/i],
  ['WATER', /\b(leak|leaking|flood|water|ceiling\s+stain|dripping)\b/i],
];

const clarificationRules: Array<{ pattern: RegExp; questions: string[] }> = [
  {
    pattern: /\b(?:toilet|loo)\b.*\b(?:clog(?:ged)?|blocked|stuck)\b|\b(?:clog(?:ged)?|blocked)\b.*\b(?:toilet|loo)\b/i,
    questions: ['Is it overflowing or backing up, or is the water level staying normal?'],
  },
  {
    pattern: /\b(?:leak|leaking|dripping)\b/i,
    questions: ['Is water actively spreading or causing damage right now, or is it a small/slow leak?'],
  },
  {
    pattern: /\b(?:emergency|urgent|as\s+soon\s+as\s+possible|right\s+away|immediately)\b/i,
    questions: ['Is anyone in immediate danger, or is there active flooding, fire, gas, electrical danger, or another safety risk?'],
  },
];

function normaliseInput(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function classifyMaintenanceMessage(text: string): MaintenanceClassification {
  const input = normaliseInput(text);
  const matchedSafetySignals = emergencySignals
    .filter(({ pattern }) => pattern.test(input))
    .map(({ label }) => label);

  const category = matchedSafetySignals.includes('uncontrolled_water')
    ? 'WATER'
    : matchedSafetySignals.includes('structural_collapse')
      ? 'STRUCTURAL'
      : categoryRules.find(([, pattern]) => pattern.test(input))?.[0] ?? 'OTHER';

  if (matchedSafetySignals.length > 0) {
    return {
      category,
      urgency: 'EMERGENCY',
      humanEscalationRequired: true,
      matchedSafetySignals,
      recommendedNextStep: 'ESCALATE_HUMAN',
      clarificationQuestions: [],
    };
  }

  const clarificationQuestions = clarificationRules.find(({ pattern }) => pattern.test(input))?.questions ?? [];

  if (category === 'ELECTRICAL') {
    return {
      category,
      urgency: 'PRIORITY',
      humanEscalationRequired: true,
      matchedSafetySignals,
      recommendedNextStep: 'REQUEST_MEDIA',
      clarificationQuestions,
    };
  }

  if (category === 'WATER' || category === 'PLUMBING') {
    return {
      category,
      urgency: 'PRIORITY',
      humanEscalationRequired: false,
      matchedSafetySignals,
      recommendedNextStep: 'REQUEST_MEDIA',
      clarificationQuestions,
    };
  }

  return {
    category,
    urgency: 'ROUTINE',
    humanEscalationRequired: false,
    matchedSafetySignals,
    recommendedNextStep: 'REQUEST_MEDIA',
    clarificationQuestions,
  };
}
