import { listRegisteredTools } from './aiToolPolicy.js';

/**
 * Every agent in AURA, and what each one is allowed to do.
 *
 * WHY THIS FILE EXISTS. An agent is software acting on a business's behalf,
 * sometimes without anyone watching. "Which of these can send a customer a
 * message?" and "what can this one reach?" are questions an owner, an
 * auditor, or whoever is on call at 2am is entitled to answer in one place
 * rather than by reading the codebase.
 *
 * WHY THIS VERSION IS DIFFERENT FROM THE ONE THAT WAS DELETED. The previous
 * registry described a routing system - domain agents with capabilities and
 * approval rules - that did not exist and was imported nowhere. It read
 * like working code, which made it worse than nothing: anyone consulting it
 * would have believed AURA routed conversations in a way it never has.
 *
 * So this one carries no behaviour and makes no claim that anything reads
 * it. It is a register, and its accuracy is ENFORCED rather than trusted:
 * agentRegistry.test.ts fails the build when
 *
 *   - a tool is registered in aiToolPolicy and claimed by no agent here;
 *   - an agent here claims a tool that is not registered in aiToolPolicy;
 *   - two agents claim the same tool;
 *   - an implementation path cited here does not exist on disk.
 *
 * That last check is what stops a register from rotting. A registry that
 * can cite a deleted file is a registry nobody should believe.
 *
 * WHAT IS NOT HERE. The agents a business creates for itself live in the
 * `ai_agents` table, one set per business, configured from the Agents page -
 * they are data, and no static file can enumerate them. What is listed here
 * is the SURFACES: the places in this software where something acts on a
 * business's behalf. A business's own agent runs on the customer_reply
 * surface below and inherits exactly its tools and limits.
 */

export type AgentSurface =
  /** Generates the replies customers actually receive over WhatsApp. */
  | 'customer_reply'
  /** Answers the operator inside AURA. Its output is never delivered to a customer. */
  | 'operator_console'
  /** Runs on a schedule with nobody watching. */
  | 'background_sweep'
  /** Inspects content on the way in or out. Blocks; never composes. */
  | 'safety_pipeline'
  /** An external runtime AURA exposes tools to, rather than one it drives. */
  | 'external_runtime';

export interface RegisteredAgent {
  id: string;
  displayName: string;
  /** 'business' when an owner configures it from the Agents page; 'platform' when it is part of AURA and not theirs to tune. */
  configuredBy: 'business' | 'platform';
  surface: AgentSurface;
  purpose: string;
  /** Tools from aiToolPolicy this surface may invoke. Every registered tool belongs to exactly one entry. */
  tools: string[];
  /** Stated rather than left to be inferred - the point of a register is that a limit is written down. */
  neverDoes: string[];
  /** Whether anything it produces can reach a customer. The first question worth asking about any agent. */
  reachesCustomer: boolean;
  /** Where it really lives, relative to the repository root. Checked to exist. */
  implementation: string;
}

export const AGENT_REGISTRY: readonly RegisteredAgent[] = [
  {
    id: 'customer_reply',
    displayName: 'Customer reply agent',
    configuredBy: 'business',
    surface: 'customer_reply',
    purpose:
      "Answers customers over WhatsApp in the business's own voice. This is the surface a business's own agents run " +
      'on: persona, tone, autonomy level, allowed tools and protected facts all come from that business\'s ai_agents ' +
      'row, so two businesses on this one surface behave nothing alike.',
    tools: [
      'get_current_time',
      'update_conversation_memory',
      'take_a_message',
      'schedule_google_meet',
      'schedule_zoom_meeting',
      'list_properties',
      'check_property_status',
      'list_retail_products',
      'check_retail_order_status',
      'list_menu',
      'quote_food_order',
      'confirm_food_order',
    ],
    neverDoes: [
      'Set or alter a price, a total, a tax or a delivery fee - every figure it quotes is computed server-side from the catalogue',
      'Mark an order paid, or send one to the kitchen unpaid',
      'Disclose a protected fact (enforced by the outbound leak guard, not by instruction)',
      'Address or answer a colleague on its own side',
      'Reply to a business\'s own operator',
    ],
    reachesCustomer: true,
    implementation: 'src/services/aiReplyService.ts',
  },
  {
    id: 'operator_assistant',
    displayName: 'Operator assistant',
    configuredBy: 'platform',
    surface: 'operator_console',
    purpose:
      'Answers the operator inside AURA - summarising a conversation, drafting a reply for them to review, ' +
      'explaining what happened on an order. Its output is shown to the operator and never delivered anywhere.',
    tools: [],
    neverDoes: [
      'Send anything to a customer - nothing it produces leaves AURA unless a person sends it',
      'Invoke a tool from the shared registry',
    ],
    reachesCustomer: false,
    implementation: 'src/services/operator/assistantModeService.ts',
  },
  {
    id: 'sentinel',
    displayName: 'Sentinel',
    configuredBy: 'platform',
    surface: 'safety_pipeline',
    purpose:
      'Screens inbound content before it reaches the reply path, and outbound replies before they reach a customer. ' +
      'It only ever blocks or allows - it composes nothing, so a failure of judgment here can withhold a reply but ' +
      'can never put words in one.',
    tools: [],
    neverDoes: ['Compose or alter a reply', 'Write to any business record', 'Invoke a tool from the shared registry'],
    reachesCustomer: false,
    implementation: 'src/security/sentinel/sentinel.ts',
  },
  {
    id: 'business_intelligence_sweep',
    displayName: 'Business intelligence sweep',
    configuredBy: 'platform',
    surface: 'background_sweep',
    purpose:
      'Reads a business\'s own conversation history on a schedule and writes insights and trends for the owner to ' +
      'read. Runs with nobody watching, which is exactly why it writes only to its own tables.',
    tools: [],
    neverDoes: [
      'Message a customer',
      'Change an order, a price, or any operational record',
      'Send personal information to a model without redaction (see piiRedactionService)',
    ],
    reachesCustomer: false,
    implementation: 'src/services/businessIntelligence/businessIntelligenceSweepService.ts',
  },
  {
    id: 'oversight_sweep',
    displayName: 'Oversight sweep',
    configuredBy: 'platform',
    surface: 'background_sweep',
    purpose:
      'Looks for work that has gone quiet - a conversation nobody answered, an order stuck in a stage - and raises ' +
      'it with a human. It reports; it does not resolve.',
    tools: [],
    neverDoes: ['Message a customer', 'Resolve or close the thing it found', 'Invoke a tool from the shared registry'],
    reachesCustomer: false,
    implementation: 'src/services/oversight/oversightSweepService.ts',
  },
  {
    id: 'learn_capture',
    displayName: 'Writing-style capture',
    configuredBy: 'platform',
    surface: 'background_sweep',
    purpose:
      "Learns how a business's own people write, from messages they really sent, so generated replies sound like " +
      'them. Observes only.',
    tools: [],
    neverDoes: ['Message a customer', 'Alter a message somebody sent', 'Invoke a tool from the shared registry'],
    reachesCustomer: false,
    implementation: 'src/services/learn/learnCaptureService.ts',
  },
  {
    id: 'openclaw_gateway',
    displayName: 'OpenClaw tool gateway',
    configuredBy: 'platform',
    surface: 'external_runtime',
    purpose:
      'Exposes a deliberately narrow, separately-governed set of tools to an external agent runtime. Its tools are ' +
      'NOT in the shared registry above, and that separation is load-bearing: an external runtime must never be ' +
      'able to reach the tools the customer-reply path uses.',
    tools: [],
    neverDoes: [
      'Invoke a tool from the shared aiToolPolicy registry',
      'Reach another tenant\'s records - every call is re-scoped to the caller\'s business',
    ],
    reachesCustomer: false,
    implementation: 'src/services/openclawToolGateway.ts',
  },
  {
    id: 'qc_photo_check',
    displayName: 'Quality check photo reader',
    configuredBy: 'platform',
    surface: 'operator_console',
    purpose:
      'Reads a photograph of a packed food order at the pass and reports only what it can SEE, so a contradiction ' +
      "with the order - ketchup on a burger ordered without it - is put in front of the person packing it. Off " +
      'until a business turns it on.',
    // No tools at all: it is handed an image and a list of dishes and
    // answers in JSON. It cannot call anything, which is why this surface
    // can be given a photograph without widening what an AI can reach.
    tools: [],
    neverDoes: [
      'Report that something is missing - a photograph cannot establish absence, so it is never asked and has no field to answer in',
      'Stop an order leaving the pass - a person still bumps the ticket; this only decides whether they see a warning first',
      "Receive any customer detail - the prompt builder is handed order lines alone, so there is no name, number, address or order number to send",
      'Send anything to a customer',
    ],
    reachesCustomer: false,
    implementation: 'src/services/food/qcVisionCheck.ts',
  },
];

export function findAgent(id: string): RegisteredAgent | null {
  return AGENT_REGISTRY.find((agent) => agent.id === id) ?? null;
}

/** Which registered agent may invoke this tool, or null when no agent claims it - which the test treats as a failure. */
export function agentForTool(toolName: string): RegisteredAgent | null {
  return AGENT_REGISTRY.find((agent) => agent.tools.includes(toolName)) ?? null;
}

/** Every agent whose output can reach a customer. The shortest useful audit question. */
export function agentsReachingCustomers(): readonly RegisteredAgent[] {
  return AGENT_REGISTRY.filter((agent) => agent.reachesCustomer);
}

/** Tools registered in aiToolPolicy that no agent here claims. Non-empty means this register is out of date. */
export function unclaimedTools(): string[] {
  return listRegisteredTools()
    .map((tool) => tool.name)
    .filter((name) => !agentForTool(name));
}
