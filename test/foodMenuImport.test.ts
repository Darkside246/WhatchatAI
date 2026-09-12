import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { parseMenuText } from '../src/domain/food/menuImport.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { importMenu } from '../src/services/food/menuImportService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * A restaurant's menu already exists - in a Word document, a PDF, a
 * WhatsApp message to a designer. The parser has to cope with how those
 * actually look, not with a format we would have chosen.
 */
describe('reading a pasted menu', () => {
  it('reads the shape a real menu is written in', () => {
    const parsed = parseMenuText(`
STARTERS
Chicken wings  9.00
Nachos 11.50

MAINS
Beef burger 18.00
Grilled snapper  24.00
    `);

    expect(parsed.categories).toEqual(['STARTERS', 'MAINS']);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items[0]).toMatchObject({ category: 'STARTERS', name: 'Chicken wings', priceCents: 900 });
    expect(parsed.items[3]).toMatchObject({ category: 'MAINS', name: 'Grilled snapper', priceCents: 2400 });
    expect(parsed.unparsed).toHaveLength(0);
  });

  /** A printed menu runs dots or a dash between the dish and the price. */
  it('strips the leaders a printed menu uses', () => {
    const parsed = parseMenuText('Beef burger .......... 18.00\nFish cutter - 12\nRoti | 15.00');
    expect(parsed.items.map((item) => item.name)).toEqual(['Beef burger', 'Fish cutter', 'Roti']);
    expect(parsed.items.map((item) => item.priceCents)).toEqual([1800, 1200, 1500]);
  });

  /** A restaurant writes "18" and "18.00" on the same page and means the same thing. */
  it('takes whole units and decimals alike', () => {
    const parsed = parseMenuText('Wings 9\nNachos 11.5\nRoti 12.00');
    expect(parsed.items.map((item) => item.priceCents)).toEqual([900, 1150, 1200]);
  });

  it('discards a currency symbol rather than choking on it', () => {
    const parsed = parseMenuText('Wings $9.00\nNachos BBD 11.00\nRoti €12');
    expect(parsed.items.map((item) => item.priceCents)).toEqual([900, 1100, 1200]);
  });

  /** "2 for 1 Tuesdays 15.00" is fifteen dollars, not two. */
  it('takes the price at the end, not the first number it sees', () => {
    const parsed = parseMenuText('2 for 1 Tuesdays 15.00');
    expect(parsed.items[0]).toMatchObject({ name: '2 for 1 Tuesdays', priceCents: 1500 });
  });

  describe('the one genuinely ambiguous line', () => {
    /** A heading is short. A description is a sentence. Decided on evidence rather than guessed. */
    it('treats a sentence under an item as its description', () => {
      const parsed = parseMenuText(`MAINS
Beef burger 18.00
Aged beef, smoked cheddar, house pickles and our own sauce
Fish cutter 12.00`);

      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0]?.description).toBe('Aged beef, smoked cheddar, house pickles and our own sauce');
      expect(parsed.categories).toEqual(['MAINS']);
    });

    it('treats a short line with no price as a section', () => {
      const parsed = parseMenuText('Sides & Salads\nFries 6.00');
      expect(parsed.categories).toEqual(['Sides & Salads']);
      expect(parsed.items[0]?.category).toBe('Sides & Salads');
    });

    it('drops the punctuation a heading is written with', () => {
      expect(parseMenuText('STARTERS:\nWings 9').categories).toEqual(['STARTERS']);
      expect(parseMenuText('— MAINS —\nBurger 18').categories).toEqual(['— MAINS']);
    });

    /**
     * A description only ever attaches to the item on the line directly
     * above it, so a stray sentence at the end of a menu does not become
     * the description of something unrelated.
     */
    it('does not attach a stray sentence to a distant item', () => {
      const parsed = parseMenuText(`Beef burger 18.00

All our prices include VAT, and service is not included`);

      expect(parsed.items[0]?.description).toBeNull();
      expect(parsed.unparsed).toHaveLength(1);
      expect(parsed.unparsed[0]?.line).toBe(3);
    });
  });

  describe('what it refuses to guess at', () => {
    /** An item imported at the wrong price is worse than one not imported at all. */
    it('hands back a bare number rather than inventing a dish', () => {
      const parsed = parseMenuText('MAINS\n18.00');
      expect(parsed.items).toHaveLength(0);
      expect(parsed.unparsed[0]?.reason).toContain('nothing to call it');
    });

    it('points at the line somebody has to look at', () => {
      const parsed = parseMenuText('Wings 9.00\nsomething long enough to read as prose, with a comma\nNachos 11.00');
      expect(parsed.items).toHaveLength(2);
      // Line 2 attaches as the description of line 1 - which is the right
      // reading, and the preview shows it before anything is written.
      expect(parsed.items[0]?.description).toContain('something long enough');
    });
  });

  it('copes with an empty paste', () => {
    expect(parseMenuText('')).toEqual({ items: [], categories: [], unparsed: [] });
    expect(parseMenuText('   \n\n  ')).toEqual({ items: [], categories: [], unparsed: [] });
  });
});

describe('importing a pasted menu (real Postgres)', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  const MENU = `STARTERS
Chicken wings 9.00
Nachos 11.50

MAINS
Beef burger 18.00
Aged beef, smoked cheddar and our own sauce`;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
  });

  /**
   * The property the whole screen rests on: the preview and the commit are
   * the same code with one flag between them, so what somebody was shown
   * is what actually happens.
   */
  it('writes nothing on a dry run, and exactly what it previewed on the real one', async () => {
    const preview = await importMenu(repo, businessId, MENU, { dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.counts).toEqual({ create: 3, update: 0, skip: 0 });
    expect(preview.newCategories).toEqual(['STARTERS', 'MAINS']);
    expect(await repo.listMenu(businessId)).toHaveLength(0);

    const applied = await importMenu(repo, businessId, MENU, { dryRun: false });
    expect(applied.counts).toEqual(preview.counts);
    expect(applied.rows.map((row) => row.name)).toEqual(preview.rows.map((row) => row.name));

    const menu = await repo.listMenu(businessId);
    expect(menu).toHaveLength(3);
    // Placed in the sections the paste named, in the order it named them.
    expect(menu.map((item) => `${item.category}/${item.name}`)).toEqual([
      'STARTERS/Chicken wings',
      'STARTERS/Nachos',
      'MAINS/Beef burger',
    ]);
    expect(menu[2]?.description).toBe('Aged beef, smoked cheddar and our own sauce');
  });

  /**
   * Re-importing after adding three dishes is a normal thing to do by
   * accident. It must not silently reset thirty prices somebody has since
   * corrected by hand.
   */
  it('leaves what is already there alone unless asked', async () => {
    await importMenu(repo, businessId, MENU, { dryRun: false });
    const burger = (await repo.listMenu(businessId)).find((item) => item.name === 'Beef burger')!;
    await repo.updateMenuItem(businessId, burger.id, { priceCents: 2000 });

    const again = await importMenu(repo, businessId, MENU, { dryRun: false });
    expect(again.counts).toEqual({ create: 0, update: 0, skip: 3 });

    const unchanged = (await repo.listMenu(businessId)).find((item) => item.name === 'Beef burger');
    expect(unchanged?.priceCents).toBe(2000);
  });

  it('updates the price when the owner asks for it, and says what changes', async () => {
    await importMenu(repo, businessId, MENU, { dryRun: false });
    const burger = (await repo.listMenu(businessId)).find((item) => item.name === 'Beef burger')!;
    await repo.updateMenuItem(businessId, burger.id, { priceCents: 2000 });

    const preview = await importMenu(repo, businessId, MENU, { dryRun: true, updateExisting: true });
    const row = preview.rows.find((entry) => entry.name === 'Beef burger');
    expect(row?.action).toBe('update');
    expect(row?.note).toContain('20.00 to 18.00');

    await importMenu(repo, businessId, MENU, { dryRun: false, updateExisting: true });
    expect((await repo.listMenu(businessId)).find((item) => item.name === 'Beef burger')?.priceCents).toBe(1800);
  });

  /** "Import my menu" does not mean "wipe the copy I wrote by hand". */
  it('never blanks a description the paste does not carry', async () => {
    await repo.createMenuItem({ businessId, name: 'Nachos', priceCents: 1150, description: 'The good ones' });

    await importMenu(repo, businessId, 'Nachos 11.50', { dryRun: false, updateExisting: true });

    expect((await repo.listMenu(businessId))[0]?.description).toBe('The good ones');
  });

  /** A section that already exists is reused, not duplicated under different casing. */
  it('joins a section that already exists', async () => {
    await repo.createCategory(businessId, 'Mains');

    await importMenu(repo, businessId, 'MAINS\nBeef burger 18.00', { dryRun: false });

    const categories = await repo.listCategories(businessId);
    expect(categories).toHaveLength(1);
    expect((await repo.listMenu(businessId))[0]?.categoryId).toBe(categories[0]?.id);
  });

  it('matches an existing dish however it was capitalised', async () => {
    await repo.createMenuItem({ businessId, name: 'Beef Burger', priceCents: 1800 });

    const preview = await importMenu(repo, businessId, 'beef burger 18.00', { dryRun: true });
    expect(preview.counts.skip).toBe(1);
    expect(preview.counts.create).toBe(0);
  });

  it('does not import into another business', async () => {
    const otherBusinessId = await createTestBusiness('Someone Else');
    await importMenu(repo, businessId, MENU, { dryRun: false });
    expect(await repo.listMenu(otherBusinessId)).toHaveLength(0);
  });
});
