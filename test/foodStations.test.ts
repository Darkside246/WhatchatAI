import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Where each item is made.
 *
 * The station column has existed on menu items since the menu was built and
 * nothing ever read it, so a kitchen could fill it in and see no effect
 * anywhere. These cover the two lookups the board uses to change that.
 */
describe('kitchen stations', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
  });

  it('maps each item to its station, and leaves out the ones with none', async () => {
    const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, station: 'Grill' });
    const fries = await repo.createMenuItem({ businessId, name: 'Fries', priceCents: 500, station: 'Fryer' });
    const water = await repo.createMenuItem({ businessId, name: 'Water', priceCents: 200 });

    const stations = await repo.stationByMenuItem(businessId);

    expect(stations.get(burger.id)).toBe('Grill');
    expect(stations.get(fries.id)).toBe('Fryer');
    // Absent rather than null: an item with no station is unrouted, and the
    // board shows that as its own bucket rather than inventing a station.
    expect(stations.has(water.id)).toBe(false);
  });

  it('treats a whitespace-only station as no station at all', async () => {
    const item = await repo.createMenuItem({ businessId, name: 'Bread', priceCents: 300, station: '   ' });

    expect((await repo.stationByMenuItem(businessId)).has(item.id)).toBe(false);
    expect(await repo.listStations(businessId)).toEqual([]);
  });

  it('trims the station it hands back, so a stray space is not a second station', async () => {
    const item = await repo.createMenuItem({ businessId, name: 'Wings', priceCents: 900, station: ' Fryer ' });

    expect((await repo.stationByMenuItem(businessId)).get(item.id)).toBe('Fryer');
    expect(await repo.listStations(businessId)).toEqual(['Fryer']);
  });

  it('lists each station once however the menu spells it', async () => {
    // A menu edited over months will have both spellings. Two entries in the
    // picker for one station is the same confusion as none.
    await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, station: 'Grill' });
    await repo.createMenuItem({ businessId, name: 'Steak', priceCents: 3200, station: 'grill' });
    await repo.createMenuItem({ businessId, name: 'Fries', priceCents: 500, station: 'Fryer' });

    expect(await repo.listStations(businessId)).toEqual(['Fryer', 'Grill']);
  });

  it('is empty for a kitchen that has not assigned any', async () => {
    await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });

    expect(await repo.listStations(businessId)).toEqual([]);
    expect((await repo.stationByMenuItem(businessId)).size).toBe(0);
  });

  it("never reads another business's stations", async () => {
    const other = await createTestBusiness('Someone Else');
    await repo.createMenuItem({ businessId: other, name: 'Burger', priceCents: 1800, station: 'Grill' });

    expect(await repo.listStations(businessId)).toEqual([]);
    expect((await repo.stationByMenuItem(businessId)).size).toBe(0);
  });
});
