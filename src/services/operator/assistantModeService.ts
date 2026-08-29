import { Type } from '@google/genai';
import { pool } from '../../db/pool.js';
import { aiGateway, type GatewayToolDefinition, type GatewayToolCall, type GatewayToolResponse } from '../ai/aiGateway.js';
import { ReminderRepository } from '../../repositories/reminderRepository.js';
import { timeService } from '../time/timeService.js';
import { describeTimeContext } from '../time/timeContext.js';

const reminderRepository = new ReminderRepository(pool);

const CREATE_REMINDER_TOOL: GatewayToolDefinition = {
  name: 'create_reminder',
  description:
    'Creates a reminder that will be sent back to the owner over WhatsApp at the given time. Convert any ' +
    'relative or natural time expression ("in an hour", "tomorrow morning", "Friday at 3pm") into a real, exact ' +
    'ISO 8601 datetime yourself, using the current real time you were given - never ask the owner to restate it ' +
    'as an ISO datetime themselves.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING, description: 'What to remind the owner about, in their own words.' },
      dueAtIso: { type: Type.STRING, description: 'The exact moment to send the reminder, as an ISO 8601 datetime.' },
    },
    required: ['message', 'dueAtIso'],
  },
};

const CANCEL_REMINDER_TOOL: GatewayToolDefinition = {
  name: 'cancel_reminder',
  description:
    'Cancels a reminder that has not fired yet. reminderId must be the exact id shown in the upcoming-reminders ' +
    'list you were given - never guess or invent one that is not in that list.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reminderId: { type: Type.STRING, description: 'The exact id of the reminder to cancel, copied from the upcoming-reminders list.' },
    },
    required: ['reminderId'],
  },
};

const ASSISTANT_TOOLS = [CREATE_REMINDER_TOOL, CANCEL_REMINDER_TOOL];
const MAX_REPLY_CHARS = 1000;

export interface AssistantMessageInput {
  businessId: string;
  whatsappAccountId: string;
  operatorJid: string;
  assistantName: string;
  text: string;
}

export interface AssistantMessageResult {
  reply: string;
}

async function executeTool(call: GatewayToolCall, input: AssistantMessageInput): Promise<Record<string, unknown>> {
  if (call.name === 'create_reminder') {
    const args = call.args as { message?: unknown; dueAtIso?: unknown };
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    const dueAtIso = typeof args.dueAtIso === 'string' ? args.dueAtIso : '';
    const dueAt = new Date(dueAtIso);
    if (!message || Number.isNaN(dueAt.getTime())) {
      return { error: 'message and a valid dueAtIso are both required.' };
    }
    if (dueAt.getTime() <= Date.now()) {
      return { error: 'dueAtIso must be in the future.' };
    }
    const reminder = await reminderRepository.create({
      businessId: input.businessId,
      whatsappAccountId: input.whatsappAccountId,
      notifyJid: input.operatorJid,
      message,
      dueAt: dueAt.toISOString(),
      createdByJid: input.operatorJid,
    });
    return { created: true, reminderId: reminder.id, dueAt: reminder.dueAt };
  }

  if (call.name === 'cancel_reminder') {
    const args = call.args as { reminderId?: unknown };
    const reminderId = typeof args.reminderId === 'string' ? args.reminderId : '';
    if (!reminderId) return { error: 'reminderId is required.' };
    const cancelled = await reminderRepository.cancel(reminderId, input.businessId);
    return { cancelled };
  }

  return { error: `Unknown tool "${call.name}".` };
}

/**
 * The natural-language counterpart to OperatorCommandService's rigid regex
 * commands - reached only via the /<assistantName> trigger from an already
 * PIN-authenticated operator session (see OperatorCommandService.handle()),
 * never independently authenticated here. Bounded to exactly one tool-call
 * round, the same principle used everywhere else this codebase does AI
 * tool-calling (aiReplyService's get_current_time/update_conversation_memory,
 * this being the third): a model that somehow kept re-requesting a tool
 * could never turn one WhatsApp message into an unbounded chain of calls.
 */
export async function handleAssistantMessage(input: AssistantMessageInput): Promise<AssistantMessageResult> {
  const [upcoming, timeContext] = await Promise.all([
    reminderRepository.listUpcoming(input.businessId, 10),
    timeService.buildBusinessTimeContext(input.businessId),
  ]);

  const remindersLine = upcoming.length
    ? upcoming.map((reminder) => `- [${reminder.id}] "${reminder.message}" due ${reminder.dueAt}`).join('\n')
    : 'None.';

  const systemInstruction = [
    `You are ${input.assistantName}, a private personal assistant for the owner of this WhatsApp business account.`,
    'You are speaking directly and privately with the authenticated business owner, not a customer - do not apply ' +
      'any customer-facing script, caution, or scope restriction here.',
    `The current real date and time is: ${describeTimeContext(timeContext)}. Use this, never a guess, to resolve any relative time expression.`,
    `Upcoming reminders:\n${remindersLine}`,
    'Use the create_reminder or cancel_reminder tools when the request calls for it. If the request is not about ' +
      'reminders and no tool here can help, say honestly that you cannot do that yet rather than pretending to.',
    'Keep replies short, warm, and WhatsApp-appropriate - no markdown headers, no code blocks.',
  ].join('\n\n');

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: input.text },
  ];

  try {
    const first = await aiGateway.generate({
      tenantId: input.businessId,
      operation: 'assistant.chat',
      messages,
      tools: ASSISTANT_TOOLS,
      maxOutputTokens: 500,
    });

    if (!first.toolCalls?.length) {
      return { reply: (first.text || "Sorry, I didn't quite catch that.").slice(0, MAX_REPLY_CHARS) };
    }

    const toolResponses: GatewayToolResponse[] = [];
    for (const call of first.toolCalls) {
      toolResponses.push({ name: call.name, response: await executeTool(call, input) });
    }

    const followUp = await aiGateway.generate({
      tenantId: input.businessId,
      operation: 'assistant.chat',
      messages,
      tools: ASSISTANT_TOOLS,
      pendingToolCalls: first.toolCalls,
      toolResponses,
      maxOutputTokens: 500,
    });

    return { reply: (followUp.text || 'Done.').slice(0, MAX_REPLY_CHARS) };
  } catch (error) {
    return { reply: `⚠️ I ran into a problem: ${error instanceof Error ? error.message : String(error)}` };
  }
}
