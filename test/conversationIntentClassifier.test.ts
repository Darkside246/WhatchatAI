import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../src/services/ai/conversationIntentClassifier.js';

describe('classifyMessage (Section 04 deterministic intent/entity/risk classification)', () => {
  it('classifies a greeting as low risk with no entities', () => {
    const result = classifyMessage('Hey, good morning!');
    expect(result.intent).toBe('greeting');
    expect(result.riskLevel).toBe(0);
    expect(result.sensitiveInfoDetected).toBe(false);
  });

  it('classifies a scheduling request and flags it as moderate risk', () => {
    const result = classifyMessage('Can we book a call for tomorrow at 3pm?');
    expect(result.intent).toBe('scheduling_request');
    expect(result.riskLevel).toBe(2);
  });

  it('classifies a cancellation', () => {
    const result = classifyMessage("I need to cancel, I won't be able to make it");
    expect(result.intent).toBe('cancellation');
    expect(result.riskLevel).toBe(2);
  });

  it('classifies a complaint as high risk', () => {
    const result = classifyMessage('This is unacceptable, I want a refund, I am so frustrated');
    expect(result.intent).toBe('complaint');
    expect(result.riskLevel).toBe(3);
  });

  it('classifies a plain question as low risk', () => {
    const result = classifyMessage('What time do you open on Saturdays?');
    expect(result.intent).toBe('question');
    expect(result.riskLevel).toBe(1);
  });

  it('classifies a short confirmation', () => {
    const result = classifyMessage('Yes, sounds good');
    expect(result.intent).toBe('confirmation');
    expect(result.riskLevel).toBe(1);
  });

  it('falls back to general for anything ambiguous rather than guessing', () => {
    const result = classifyMessage('The blue one please');
    expect(result.intent).toBe('general');
    expect(result.riskLevel).toBe(0);
  });

  it('detects an email entity', () => {
    const result = classifyMessage('You can reach me at jane.doe@example.com');
    expect(result.entities).toContainEqual({ type: 'email', value: 'jane.doe@example.com' });
  });

  it('detects a phone entity with real-world formatting', () => {
    const result = classifyMessage('Call me at (246) 245-1422 anytime');
    expect(result.entities.some((e) => e.type === 'phone')).toBe(true);
  });

  it('detects a money entity', () => {
    const result = classifyMessage('The quote came out to $1,250.00');
    expect(result.entities).toContainEqual({ type: 'money', value: '$1,250.00' });
  });

  it('flags a real SSN-shaped number as sensitive and bumps risk to 3', () => {
    const result = classifyMessage('My SSN is 123-45-6789');
    expect(result.sensitiveInfoDetected).toBe(true);
    expect(result.riskLevel).toBe(3);
  });

  it('does not treat an ordinary phone number as sensitive on its own', () => {
    const result = classifyMessage('Call me at 246-245-1422');
    expect(result.sensitiveInfoDetected).toBe(false);
  });

  it('never throws on empty or whitespace-only input', () => {
    expect(() => classifyMessage('')).not.toThrow();
    expect(() => classifyMessage('   ')).not.toThrow();
    expect(classifyMessage('').intent).toBe('general');
  });
});
