import { describe, expect, it } from 'vitest';
import { nextPipelineOptions } from '../../src/web/src/lib/pipelineStages.js';

describe('nextPipelineOptions (CRM lead pipeline forward-only moves)', () => {
  it('never re-offers a stage the lead has already passed through', () => {
    expect(nextPipelineOptions('ENGAGED')).not.toContain('NEW');
    expect(nextPipelineOptions('ENGAGED')).not.toContain('QUALIFIED');
    expect(nextPipelineOptions('ENGAGED')).not.toContain('ENGAGED');
  });

  it('still offers every later stage plus LOST', () => {
    expect(nextPipelineOptions('QUALIFIED').sort()).toEqual(['ENGAGED', 'LOST', 'WON'].sort());
  });

  it('offers LOST from the very first stage, since it is a valid exit at any point', () => {
    expect(nextPipelineOptions('NEW')).toContain('LOST');
  });

  it('offers no further moves once a lead is closed (WON or LOST)', () => {
    expect(nextPipelineOptions('WON')).toEqual([]);
    expect(nextPipelineOptions('LOST')).toEqual([]);
  });
});
