import { describe, expect, it } from 'vitest';
import {
  UNASSIGNED_STATION,
  lineIsForStation,
  stationOptions,
  ticketIsForStation,
  ticketsWithUnassignedWork,
} from '../../src/web/src/lib/stationView.js';

const grillTicket = { items: [{ station: 'Grill' }, { station: 'Fryer' }] };
const fryerOnly = { items: [{ station: 'Fryer' }] };
const unrouted = { items: [{ station: null }] };
const mixed = { items: [{ station: 'Grill' }, { station: null }] };

describe('station views', () => {
  it('shows every ticket on the whole board', () => {
    for (const ticket of [grillTicket, fryerOnly, unrouted, mixed]) {
      expect(ticketIsForStation(ticket, null)).toBe(true);
    }
  });

  it('shows a ticket to a station it has any work for', () => {
    expect(ticketIsForStation(grillTicket, 'Grill')).toBe(true);
    expect(ticketIsForStation(grillTicket, 'Fryer')).toBe(true);
    expect(ticketIsForStation(fryerOnly, 'Grill')).toBe(false);
  });

  it('treats a station name as the same station however it is spelled', () => {
    // A menu edited over months will have both. Two screens for one station
    // is the same bug as none.
    expect(ticketIsForStation(grillTicket, 'grill')).toBe(true);
    expect(ticketIsForStation(grillTicket, '  GRILL ')).toBe(true);
  });

  it('never leaves an unrouted line with no screen to appear on', () => {
    // The failure this whole module exists to prevent: an item nobody has
    // assigned a station to must still be reachable, or it is simply never
    // made and nobody finds out until the customer asks.
    expect(ticketIsForStation(unrouted, 'Grill')).toBe(false);
    expect(ticketIsForStation(unrouted, UNASSIGNED_STATION)).toBe(true);
  });

  it('counts an empty station string as unrouted, not as a station named ""', () => {
    expect(lineIsForStation({ station: '   ' }, UNASSIGNED_STATION)).toBe(true);
    expect(lineIsForStation({ station: '   ' }, 'Grill')).toBe(false);
  });

  it('still shows the rest of a ticket a station is only partly responsible for', () => {
    // ticketIsForStation includes it; lineIsForStation is what marks which
    // half is this station's job. The other half stays visible - a cook
    // should be able to see the ticket also needs fries.
    expect(ticketIsForStation(mixed, 'Grill')).toBe(true);
    expect(mixed.items.map((line) => lineIsForStation(line, 'Grill'))).toEqual([true, false]);
  });

  it('offers the unassigned bucket only when something is genuinely unrouted', () => {
    expect(stationOptions(['Grill', 'Fryer'], [grillTicket, fryerOnly])).toEqual([null, 'Grill', 'Fryer']);
    expect(stationOptions(['Grill', 'Fryer'], [grillTicket, unrouted])).toEqual([null, 'Grill', 'Fryer', UNASSIGNED_STATION]);
  });

  it('always offers the whole board first', () => {
    expect(stationOptions([], [])[0]).toBeNull();
  });

  it('counts the tickets carrying unrouted work, not the lines', () => {
    expect(ticketsWithUnassignedWork([grillTicket, unrouted, mixed])).toBe(2);
    expect(ticketsWithUnassignedWork([grillTicket, fryerOnly])).toBe(0);
  });
});
