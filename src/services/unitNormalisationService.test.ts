import { describe, expect, it } from 'vitest';
import { normaliseUnit, normaliseBatch } from './unitNormalisationService.js';

describe('normaliseUnit', () => {
  it('maps a standard alias to canonical with high confidence', () => {
    const result = normaliseUnit('3 tbsp olive oil');
    expect(result.canonical).toBe('tablespoon');
    expect(result.quantity).toBe(3);
    expect(result.confidence).toBe('high');
  });

  it('handles a simple fraction', () => {
    const result = normaliseUnit('1/2 cup flour');
    expect(result.canonical).toBe('cup');
    expect(result.quantity).toBeCloseTo(0.5);
    expect(result.confidence).toBe('high');
  });

  it('handles a mixed fraction (1 1/2)', () => {
    const result = normaliseUnit('1 1/2 tsp salt');
    expect(result.canonical).toBe('teaspoon');
    expect(result.quantity).toBeCloseTo(1.5);
    expect(result.confidence).toBe('high');
  });

  it('handles unicode fraction ½', () => {
    const result = normaliseUnit('½ cup milk');
    expect(result.canonical).toBe('cup');
    expect(result.quantity).toBeCloseTo(0.5);
    expect(result.confidence).toBe('high');
  });

  it('maps kg with high confidence', () => {
    const result = normaliseUnit('2kg chicken');
    expect(result.canonical).toBe('kilogram');
    expect(result.quantity).toBe(2);
    expect(result.confidence).toBe('high');
  });

  it('returns medium confidence when quantity is known but unit is unrecognised', () => {
    const result = normaliseUnit('3 handfuls rice');
    expect(result.quantity).toBe(3);
    expect(result.confidence).toBe('medium');
    expect(result.canonical).toBe('handfuls');
  });

  it('returns low confidence when only a known unit appears with no quantity', () => {
    const result = normaliseUnit('some cups of sugar');
    expect(result.canonical).toBe('cup');
    expect(result.confidence).toBe('low');
    expect(result.quantity).toBe(1);
  });

  it('falls back to piece/low when nothing matches', () => {
    const result = normaliseUnit('some stuff');
    expect(result.canonical).toBe('piece');
    expect(result.confidence).toBe('low');
  });

  it('respects business-level alias overrides', () => {
    const result = normaliseUnit('3 scoops protein', { scoops: 'scoop' });
    expect(result.canonical).toBe('scoop');
    expect(result.quantity).toBe(3);
    expect(result.confidence).toBe('high');
  });
});

describe('normaliseBatch', () => {
  it('splits confident and needs-confirmation results', () => {
    const { confident, needsConfirmation } = normaliseBatch([
      '2 tbsp oil',
      '1/2 cup flour',
      'some stuff',
    ]);
    expect(confident.map((r) => r.canonical)).toEqual(['tablespoon', 'cup']);
    expect(needsConfirmation).toHaveLength(1);
    expect(needsConfirmation[0].original).toBe('some stuff');
  });

  it('returns empty arrays for an empty input', () => {
    const { confident, needsConfirmation } = normaliseBatch([]);
    expect(confident).toHaveLength(0);
    expect(needsConfirmation).toHaveLength(0);
  });
});
