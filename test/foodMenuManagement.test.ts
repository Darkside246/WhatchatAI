import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository, UnknownMenuCategoryError } from '../src/repositories/foodOperationsRepository.js';
import { resolveProposal } from '../src/services/food/orderIntake.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('building a menu', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
  });

  describe('categories', () => {
    /** A menu read back in alphabetical order is not the menu the operator wrote. */
    it('keeps the order the operator arranged', async () => {
      const starters = await repo.createCategory(businessId, 'Starters');
      const mains = await repo.createCategory(businessId, 'Mains');

      await repo.createMenuItem({ businessId, name: 'Zucchini fries', priceCents: 800 });
      await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });

      // Looked up by name, never by position: an uncategorised menu is
      // already name-ordered, so indexing into it assigns the wrong
      // category and tests the wrong thing.
      const initial = await repo.listMenu(businessId);
      const fries = initial.find((item) => item.name === 'Zucchini fries')!;
      const burger = initial.find((item) => item.name === 'Burger')!;
      await repo.updateMenuItem(businessId, fries.id, { categoryId: starters.id });
      await repo.updateMenuItem(businessId, burger.id, { categoryId: mains.id });

      // Starters was created first, so it sorts first - even though its
      // item sorts last alphabetically.
      const menu = await repo.listMenu(businessId);
      expect(menu.map((item) => item.name)).toEqual(['Zucchini fries', 'Burger']);
    });

    it('reorders in one go', async () => {
      const starters = await repo.createCategory(businessId, 'Starters');
      const mains = await repo.createCategory(businessId, 'Mains');
      await repo.reorderCategories(businessId, [mains.id, starters.id]);

      expect((await repo.listCategories(businessId)).map((category) => category.name)).toEqual(['Mains', 'Starters']);
    });

    /** "Mains" and "mains" are one section of one menu. */
    it('does not let one section exist twice under different casing', async () => {
      const first = await repo.createCategory(businessId, 'Mains');
      const second = await repo.createCategory(businessId, 'mains');
      expect(second.id).toBe(first.id);
      expect(await repo.listCategories(businessId)).toHaveLength(1);
    });

    it('renames without orphaning its items', async () => {
      const category = await repo.createCategory(businessId, 'Mians');
      const item = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      await repo.updateMenuItem(businessId, item.id, { categoryId: category.id });

      await repo.renameCategory(businessId, category.id, 'Mains');

      const updated = (await repo.listMenu(businessId)).find((entry) => entry.name === 'Burger');
      expect(updated?.categoryId).toBe(category.id);
      expect(await repo.listCategories(businessId)).toContainEqual(expect.objectContaining({ id: category.id, name: 'Mains' }));
      // The two columns describe one fact. A rename that fixes the section
      // and leaves every item carrying the typo is the orphaning this
      // table was added to prevent.
      expect(updated?.category).toBe('Mains');
    });

    /**
     * The legacy text column and the category row say the same thing, or
     * the menu sorts one way and reads back another.
     */
    it('keeps the section name on the item in step when it is moved', async () => {
      const starters = await repo.createCategory(businessId, 'Starters');
      const mains = await repo.createCategory(businessId, 'Mains');
      const item = await repo.createMenuItem({ businessId, name: 'Wings', priceCents: 900, categoryId: starters.id });
      expect(item.category).toBe('Starters');

      const moved = await repo.updateMenuItem(businessId, item.id, { categoryId: mains.id });
      expect(moved?.category).toBe('Mains');
    });

    /** The old string-only shape still works, and now lands in a real section rather than beside one. */
    it('turns a section named as plain text into a real row', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Wings', priceCents: 900, category: 'Starters' });

      expect(item.categoryId).not.toBeNull();
      expect(await repo.listCategories(businessId)).toContainEqual(expect.objectContaining({ name: 'Starters' }));

      // The same string a second time joins the section that exists rather
      // than making a second one.
      const second = await repo.createMenuItem({ businessId, name: 'Nachos', priceCents: 1100, category: 'starters' });
      expect(second.categoryId).toBe(item.categoryId);
      expect((await repo.listCategories(businessId)).filter((category) => /starters/i.test(category.name))).toHaveLength(1);
    });

    it('refuses a section belonging to another business', async () => {
      const otherBusinessId = await createTestBusiness('Someone Else');
      const theirs = await repo.createCategory(otherBusinessId, 'Mains');

      await expect(
        repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, categoryId: theirs.id }),
      ).rejects.toBeInstanceOf(UnknownMenuCategoryError);
      expect(await repo.listMenu(businessId)).toHaveLength(0);
    });

    /** Removing a menu section must never silently delete the food in it. */
    it('leaves the food behind when a section is deleted', async () => {
      const category = await repo.createCategory(businessId, 'Specials');
      const item = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      await repo.updateMenuItem(businessId, item.id, { categoryId: category.id });

      await repo.deleteCategory(businessId, category.id);

      const menu = await repo.listMenu(businessId);
      expect(menu).toHaveLength(1);
      expect(menu[0]?.categoryId).toBeNull();
    });
  });

  describe('shared modifier groups', () => {
    /** The whole point: typed once, attached to everything that offers it. */
    it('attach to many items from one definition', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      await repo.addModifierOption(businessId, addons.id, { name: 'extra cheese', priceDeltaCents: 150 });
      await repo.addModifierOption(businessId, addons.id, { name: 'bacon', priceDeltaCents: 250 });

      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      const chicken = await repo.createMenuItem({ businessId, name: 'Chicken burger', priceCents: 1700 });
      await repo.attachModifierGroup(businessId, burger.id, addons.id);
      await repo.attachModifierGroup(businessId, chicken.id, addons.id);

      const menu = await repo.listMenu(businessId);
      for (const item of menu) {
        expect(item.modifierGroups).toHaveLength(1);
        expect(item.modifierGroups[0]?.options.map((option) => option.name).sort()).toEqual(['bacon', 'extra cheese']);
      }
    });

    /** Changing a price once changes it everywhere - the reason groups exist. */
    it('price an order from the shared definition', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      await repo.addModifierOption(businessId, addons.id, { name: 'extra cheese', priceDeltaCents: 150 });
      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, aliases: ['burger'] });
      await repo.attachModifierGroup(businessId, burger.id, addons.id);

      const result = await resolveProposal(repo, businessId, {
        fulfilmentMethod: 'PICKUP',
        lines: [{ reference: 'burger', quantity: 1, modifiers: [{ name: 'extra cheese', action: 'add' }] }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.totalCents).toBe(1950);
    });

    /** A kitchen runs out of bacon, not just of burgers. */
    it('are marked out of stock one option at a time', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      const bacon = await repo.addModifierOption(businessId, addons.id, { name: 'bacon', priceDeltaCents: 250 });
      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, aliases: ['burger'] });
      await repo.attachModifierGroup(businessId, burger.id, addons.id);

      await repo.setModifierOptionAvailability(businessId, bacon!.id, false);

      const result = await resolveProposal(repo, businessId, {
        fulfilmentMethod: 'PICKUP',
        lines: [{ reference: 'burger', quantity: 1, modifiers: [{ name: 'bacon', action: 'add' }] }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Not silently priced and cooked - it reaches the kitchen flagged so
      // somebody asks the customer.
      expect(result.resolved.lines[0]?.notes).toContain('UNAVAILABLE');
      expect(result.resolved.totalCents).toBe(1800);
    });

    it('detach from one item without affecting another', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      const chicken = await repo.createMenuItem({ businessId, name: 'Chicken', priceCents: 1700 });
      await repo.attachModifierGroup(businessId, burger.id, addons.id);
      await repo.attachModifierGroup(businessId, chicken.id, addons.id);

      await repo.detachModifierGroup(businessId, burger.id, addons.id);

      const menu = await repo.listMenu(businessId);
      expect(menu.find((item) => item.name === 'Burger')?.modifierGroups).toHaveLength(0);
      expect(menu.find((item) => item.name === 'Chicken')?.modifierGroups).toHaveLength(1);
    });

    it('attaching twice is not an error', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      await repo.attachModifierGroup(businessId, burger.id, addons.id);
      await repo.attachModifierGroup(businessId, burger.id, addons.id);

      expect((await repo.listMenu(businessId))[0]?.modifierGroups).toHaveLength(1);
    });

    it('records how many may be chosen', async () => {
      const sauce = await repo.createModifierGroup(businessId, { name: 'Choose a sauce', minSelect: 1, maxSelect: 1 });
      const [group] = await repo.listModifierGroups(businessId);
      expect(group).toMatchObject({ id: sauce.id, minSelect: 1, maxSelect: 1 });
    });

    /** A menu written before groups existed must not stop pricing. */
    it('do not break a menu that still uses the old per-item list', async () => {
      await repo.createMenuItem({
        businessId, name: 'Roti', priceCents: 1200, aliases: ['roti'],
        modifiers: [{ name: 'pepper sauce', priceDeltaCents: 100 }],
      });

      const result = await resolveProposal(repo, businessId, {
        fulfilmentMethod: 'PICKUP',
        lines: [{ reference: 'roti', quantity: 1, modifiers: [{ name: 'pepper sauce', action: 'add' }] }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.totalCents).toBe(1300);
    });

    it('do not leak across businesses', async () => {
      const addons = await repo.createModifierGroup(businessId, { name: 'Add-ons' });
      await repo.addModifierOption(businessId, addons.id, { name: 'extra cheese', priceDeltaCents: 150 });

      const otherBusinessId = await createTestBusiness('Someone Else');
      expect(await repo.listModifierGroups(otherBusinessId)).toHaveLength(0);
    });
  });

  describe('editing an item', () => {
    /** A partial save must never blank a price. */
    it('touches only what was sent', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, aliases: ['burger'], description: 'The good one' });
      await repo.updateMenuItem(businessId, item.id, { name: 'Beef burger' });

      const [updated] = await repo.listMenu(businessId);
      expect(updated?.name).toBe('Beef burger');
      expect(updated?.priceCents).toBe(1800);
      expect(updated?.aliases).toEqual(['burger']);
      expect(updated?.description).toBe('The good one');
    });

    /** A menu is written in the order it is read, not the order it was typed. */
    it('reorders the dishes within a section', async () => {
      const mains = await repo.createCategory(businessId, 'Mains');
      const burger = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, categoryId: mains.id });
      const wrap = await repo.createMenuItem({ businessId, name: 'Wrap', priceCents: 1400, categoryId: mains.id });
      const chips = await repo.createMenuItem({ businessId, name: 'Chips', priceCents: 600, categoryId: mains.id });

      await repo.reorderMenuItems(businessId, [chips.id, burger.id, wrap.id]);

      expect((await repo.listMenu(businessId)).map((item) => item.name)).toEqual(['Chips', 'Burger', 'Wrap']);
    });

    /** Added last means shown last, rather than jumping to the top of a section somebody already arranged. */
    it('puts a new dish at the end of its section', async () => {
      const mains = await repo.createCategory(businessId, 'Mains');
      await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800, categoryId: mains.id });
      await repo.createMenuItem({ businessId, name: 'Aubergine bake', priceCents: 1500, categoryId: mains.id });

      // Alphabetically the second one comes first; it is shown second
      // because that is where the operator put it.
      expect((await repo.listMenu(businessId)).map((item) => item.name)).toEqual(['Burger', 'Aubergine bake']);
    });

    it('deletes an item', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      expect(await repo.deleteMenuItem(businessId, item.id)).toBe(true);
      expect(await repo.listMenu(businessId)).toHaveLength(0);
    });

    it('cannot edit another business\'s item', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Burger', priceCents: 1800 });
      const otherBusinessId = await createTestBusiness('Someone Else');
      expect(await repo.updateMenuItem(otherBusinessId, item.id, { priceCents: 1 })).toBeNull();
      expect((await repo.listMenu(businessId))[0]?.priceCents).toBe(1800);
    });
  });
});
