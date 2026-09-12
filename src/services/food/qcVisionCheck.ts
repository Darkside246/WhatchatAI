import { aiGateway } from '../ai/aiGateway.js';
import type { FoodOrderLine } from '../../repositories/foodOperationsRepository.js';
import { classifyQcObservation, type QcFinding, type QcVisionObservation } from '../../domain/food/qcFindings.js';

/**
 * Looking at a photo of an order that is about to go out.
 *
 * The judgement about what a photograph can and cannot establish lives in
 * qcFindings.ts, not here. This file is only the plumbing: build a prompt,
 * send an image, read back a strict answer, hand it to the classifier.
 *
 * On PII: what reaches the provider is built from the ORDER LINES ALONE -
 * dish names and the changes made to them. The builder below is handed
 * nothing else, so there is no customer name, phone number, address or
 * order number to leak, whatever the model is asked for. That is a
 * property of the function's arguments rather than a rule somebody has to
 * remember to follow.
 */

/** Photos come off a phone camera; anything larger than this is resized by the browser before it arrives. */
export const MAX_QC_PHOTO_BYTES = 4 * 1024 * 1024;
export const QC_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface QcCheckResult {
  findings: QcFinding[];
  observation: QcVisionObservation;
  provider: string;
  model: string;
}

export class QcPhotoUnreadableError extends Error {}

/**
 * The prompt, built from the order lines and nothing else.
 *
 * Written to ask only what a camera can answer. It is told explicitly not
 * to report anything missing, because a model asked to check an order
 * against a photo will otherwise helpfully volunteer "I cannot see the
 * cheese" on every single order - and a screen that warns every time warns
 * about nothing.
 */
export function buildQcPrompt(lines: FoodOrderLine[]): string {
  const described = lines
    .map((line) => {
      const changes = line.modifiers.map((modifier) =>
        modifier.action === 'remove'
          ? `WITHOUT ${modifier.name}`
          : modifier.action === 'on_side'
            ? `${modifier.name} on the side`
            : `with ${modifier.name}`,
      );
      return `- ${line.quantity} x ${line.name}${changes.length > 0 ? ` (${changes.join(', ')})` : ''}`;
    })
    .join('\n');

  return [
    'You are looking at a photograph of a food order at the pass, just before it goes out.',
    '',
    'This is the order:',
    described,
    '',
    'Report ONLY what you can actually see in the photograph.',
    '',
    'Rules:',
    '1. List every ingredient, item, sauce and condiment you can genuinely identify. Include things you can see at the edges of a bun, in the layers of a sandwich, or through a lid.',
    '2. NEVER report that something is missing, absent, or not visible. Food hides under buns, lettuce and lids. You cannot see it, and saying so is wrong and unhelpful.',
    '3. Do not guess. If you are not sure what something is, leave it out.',
    '4. Count the separate portions or plates in frame. If you cannot tell, say null - that is a normal answer, not a failure.',
    '',
    'Answer as JSON only, in exactly this shape:',
    '{"visible": ["item or ingredient", "..."], "portionsInFrame": 2}',
  ].join('\n');
}

/**
 * Reads the model's answer without trusting its shape.
 *
 * A malformed answer becomes an empty observation rather than an
 * exception: a check that cannot read the photo must degrade to finding
 * nothing, not to blocking an order. The person at the pass still bumps
 * the ticket either way.
 */
export function parseObservation(raw: string): QcVisionObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { visible: [], portionsInFrame: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { visible: [], portionsInFrame: null };

  const record = parsed as Record<string, unknown>;
  const visible = Array.isArray(record.visible)
    ? record.visible.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 60)
    : [];
  const portions =
    typeof record.portionsInFrame === 'number' && Number.isInteger(record.portionsInFrame) && record.portionsInFrame >= 0
      ? record.portionsInFrame
      : null;

  return { visible, portionsInFrame: portions };
}

export async function runQcVisionCheck(input: {
  businessId: string;
  lines: FoodOrderLine[];
  photoBase64: string;
  mimeType: string;
}): Promise<QcCheckResult> {
  const response = await aiGateway.generate({
    tenantId: input.businessId,
    operation: 'food.qc_check',
    messages: [{ role: 'user', content: buildQcPrompt(input.lines) }],
    media: [{ mimeType: input.mimeType, base64Data: input.photoBase64 }],
    responseFormat: 'json',
    // Low, because this is a description of what is in a photograph, not
    // a piece of writing. Invention is the failure mode that matters.
    temperature: 0,
    maxOutputTokens: 1024,
  });

  const observation = parseObservation(response.text);
  return {
    observation,
    findings: classifyQcObservation(input.lines, observation),
    provider: response.provider,
    model: response.model,
  };
}
