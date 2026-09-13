/**
 * Showing one station only what it has to make.
 *
 * The whole value of a station view is that the fryer stops reading grill
 * tickets. The whole danger of one is that a line ends up on no screen at
 * all and simply never gets made - which is a worse failure than the
 * problem it solves, because nobody finds out until a customer asks.
 *
 * So the rule here is deliberately one-directional: a station view narrows
 * which TICKETS are shown, and never hides a line within a ticket it shows.
 * A cook looking at a grill ticket can see it also needs fries; they just
 * are not being asked to make them. And an item nobody has assigned a
 * station to is not silently dropped - it is its own bucket, pickable, so
 * an unrouted item is always reachable from somewhere.
 */

/**
 * The bucket for lines with no station.
 *
 * A sentinel rather than null, so it can be a real selectable value in a
 * picker. Double-underscored so it can never collide with a station somebody
 * has actually named - a kitchen may well have one called "none".
 */
export const UNASSIGNED_STATION = '__unassigned__';

/** Null means every station - the whole board, which stays the default. */
export type StationSelection = string | null;

export interface StationLine {
  station: string | null;
}

export interface StationTicket {
  items: StationLine[];
}

/** Stations are matched case-insensitively: "Grill" and "grill" are one station, however the menu happens to spell them. */
function sameStation(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Is this line the chosen station's work?
 *
 * Used to decide what a cook is being ASKED to make, not what they are
 * allowed to see - see the module comment. On the whole-board view every
 * line is work, because there is nobody else to do it.
 */
export function lineIsForStation(line: StationLine, selection: StationSelection): boolean {
  if (selection === null) return true;
  if (selection === UNASSIGNED_STATION) return line.station === null || line.station.trim() === '';
  return line.station !== null && sameStation(line.station, selection);
}

/** Does this ticket carry any work for the chosen station? */
export function ticketIsForStation(ticket: StationTicket, selection: StationSelection): boolean {
  if (selection === null) return true;
  return ticket.items.some((line) => lineIsForStation(line, selection));
}

/**
 * How many live tickets carry a line nobody has routed anywhere.
 *
 * Surfaced on the board rather than left to be discovered, because an
 * unrouted item is invisible to every station view by name and would
 * otherwise only be found by the customer who never got it. It is a prompt
 * to finish setting up the menu, not an error.
 */
export function ticketsWithUnassignedWork(tickets: StationTicket[]): number {
  return tickets.filter((ticket) => ticket.items.some((line) => lineIsForStation(line, UNASSIGNED_STATION))).length;
}

/**
 * The stations to offer, given what the menu defines and what is live.
 *
 * The menu's own list leads, so the picker keeps its shape through service.
 * The unassigned bucket is only offered when something is genuinely
 * unrouted - a kitchen that has assigned everything should not be shown an
 * empty bucket forever.
 */
export function stationOptions(menuStations: string[], tickets: StationTicket[]): StationSelection[] {
  const options: StationSelection[] = [null, ...menuStations];
  if (ticketsWithUnassignedWork(tickets) > 0) options.push(UNASSIGNED_STATION);
  return options;
}
