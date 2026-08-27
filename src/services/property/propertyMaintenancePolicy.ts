import { z } from 'zod';

export const MaintenanceClassificationSchema = z.object({
  category: z.enum(['WATER', 'ELECTRICAL', 'HVAC', 'APPLIANCE', 'PLUMBING', 'STRUCTURAL', 'SECURITY', 'OTHER']),
  urgency: z.enum(['ROUTINE', 'PRIORITY', 'EMERGENCY']),
  humanEscalationRequired: z.boolean(),
  matchedSafetySignals: z.array(z.string()),
  recommendedNextStep: z.enum(['REQUEST_MEDIA', 'CREATE_WORK_ORDER', 'ESCALATE_HUMAN', 'CONTACT_EMERGENCY_SERVICE']),
});
export type MaintenanceClassification = z.infer<typeof MaintenanceClassificationSchema>;

const emergencySignals: Array<{ label: string; pattern: RegExp }> = [
  { label: 'fire_or_smoke', pattern: /\b(fire|smoke|flame|burning smell)\b/i },
  { label: 'gas_or_fuel', pattern: /\b(gas leak|gas smell|propane|fuel leak)\b/i },
  { label: 'electrical_danger', pattern: /\b(sparking|sparks|exposed wire|live wire|electric shock|electrical fire)\b/i },
  { label: 'uncontrolled_water', pattern: /\b(flooding|water pouring|burst pipe|water everywhere|ceiling is collapsing)\b/i },
  { label: 'security_threat', pattern: /\b(break in|break-in|intruder|armed|threatened|dangerous person)\b/i },
];

// More specific categories must precede generic WATER signals. Otherwise a
// phrase such as "sink is dripping" is incorrectly classified as WATER.
const categoryRules: Array<[MaintenanceClassification['category'], RegExp]> = [
  ['ELECTRICAL', /\b(ac power|breaker|circuit|electrical|outlet|socket|fuse|electric)\b/i],
  ['HVAC', /\b(ac|air condition|air-conditioning|thermostat|hvac|heat pump|cooling)\b/i],
  ['APPLIANCE', /\b(fridge|refrigerator|oven|stove|washer|dryer|dishwasher|microwave|appliance)\b/i],
  ['PLUMBING', /\b(toilet|sink|drain|faucet|tap|shower|plumbing)\b/i],
  ['STRUCTURAL', /\b(ceiling|roof|wall|window|door frame|foundation|structural)\b/i],
  ['SECURITY', /\b(lock|alarm|camera|key|intruder|security)\b/i],
  ['WATER', /\b(leak|leaking|flood|water|ceiling stain|dripping)\b/i],
];

export function classifyMaintenanceMessage(text: string): MaintenanceClassification {
  const input = text.trim();
  const matchedSafetySignals = emergencySignals.filter(({ pattern }) => pattern.test(input)).map(({ label }) => label);
  const category = categoryRules.find(([, pattern]) => pattern.test(input))?.[0] ?? 'OTHER';

  if (matchedSafetySignals.length > 0) {
    return {
      category,
      urgency: 'EMERGENCY',
      humanEscalationRequired: true,
      matchedSafetySignals,
      recommendedNextStep: 'ESCALATE_HUMAN',
    };
  }

  if (category === 'ELECTRICAL') {
    return {
      category,
      urgency: 'PRIORITY',
      humanEscalationRequired: true,
      matchedSafetySignals,
      recommendedNextStep: 'REQUEST_MEDIA',
    };
  }

  if (category === 'WATER' || category === 'PLUMBING') {
    return {
      category,
      urgency: 'PRIORITY',
      humanEscalationRequired: false,
      matchedSafetySignals,
      recommendedNextStep: 'REQUEST_MEDIA',
    };
  }

  return {
    category,
    urgency: 'ROUTINE',
    humanEscalationRequired: false,
    matchedSafetySignals,
    recommendedNextStep: 'REQUEST_MEDIA',
  };
}
