import type { FoodOperationsRepository } from '../../repositories/foodOperationsRepository.js';
import { parseMenuText, type ParsedMenu, type UnparsedLine } from '../../domain/food/menuImport.js';

/**
 * Turning a pasted menu into a real one.
 *
 * The single property that matters here: the PREVIEW and the COMMIT run
 * the same function, with one boolean between them. A preview produced by
 * different code from the commit is a preview that can lie, and the whole
 * point of showing somebody forty rows before writing them is that they
 * can trust what they are looking at.
 */

export interface MenuImportRow {
  name: string;
  category: string | null;
  priceCents: number;
  description: string | null;
  line: number;
  /**
   * What this row will do. Decided against the menu as it stands right
   * now, so a preview taken an hour ago and applied after somebody else
   * edited the menu will say so rather than quietly overwrite them.
   */
  action: 'create' | 'update' | 'skip';
  /** Why, when the answer is not "create". Written for a person, not a log. */
  note: string | null;
}

export interface MenuImportResult {
  dryRun: boolean;
  rows: MenuImportRow[];
  /** Sections that will be created. Existing ones are matched case-insensitively and reused. */
  newCategories: string[];
  unparsed: UnparsedLine[];
  counts: { create: number; update: number; skip: number };
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Works out what the paste would do, and - unless this is a dry run - does
 * it.
 *
 * `updateExisting` defaults to false, so the safe reading of a re-paste is
 * "leave what is already there alone". Re-importing a menu after adding
 * three dishes is a normal thing to do by accident, and it must not
 * silently reset thirty prices somebody has since corrected by hand.
 */
export async function importMenu(
  repository: FoodOperationsRepository,
  businessId: string,
  text: string,
  options: { dryRun: boolean; updateExisting?: boolean },
): Promise<MenuImportResult> {
  const parsed: ParsedMenu = parseMenuText(text);
  const updateExisting = options.updateExisting ?? false;

  const [existingItems, existingCategories] = await Promise.all([
    repository.listMenu(businessId),
    repository.listCategories(businessId),
  ]);

  const itemsByName = new Map(existingItems.map((item) => [normalise(item.name), item]));
  const categoriesByName = new Map(existingCategories.map((category) => [normalise(category.name), category]));

  const newCategories = parsed.categories.filter((name) => !categoriesByName.has(normalise(name)));

  const rows: MenuImportRow[] = parsed.items.map((item) => {
    const existing = itemsByName.get(normalise(item.name));
    if (!existing) {
      return { ...item, action: 'create' as const, note: null };
    }
    if (!updateExisting) {
      return {
        ...item,
        action: 'skip' as const,
        note: 'Already on your menu. Nothing is changed unless you ask for prices to be updated.',
      };
    }
    return {
      ...item,
      action: 'update' as const,
      note:
        existing.priceCents === item.priceCents
          ? 'Already on your menu at this price.'
          : `Price changes from ${(existing.priceCents / 100).toFixed(2)} to ${(item.priceCents / 100).toFixed(2)}.`,
    };
  });

  const counts = {
    create: rows.filter((row) => row.action === 'create').length,
    update: rows.filter((row) => row.action === 'update').length,
    skip: rows.filter((row) => row.action === 'skip').length,
  };

  if (options.dryRun) {
    return { dryRun: true, rows, newCategories, unparsed: parsed.unparsed, counts };
  }

  // Sections first, so every item can be placed as it is written rather
  // than created loose and tidied up afterwards.
  const categoryIds = new Map(categoriesByName);
  for (const name of parsed.categories) {
    const key = normalise(name);
    if (!categoryIds.has(key)) {
      categoryIds.set(key, await repository.createCategory(businessId, name));
    }
  }

  for (const row of rows) {
    const categoryId = row.category ? categoryIds.get(normalise(row.category))?.id ?? null : null;

    if (row.action === 'create') {
      await repository.createMenuItem({
        businessId,
        name: row.name,
        priceCents: row.priceCents,
        categoryId,
        description: row.description,
      });
      continue;
    }

    if (row.action === 'update') {
      const existing = itemsByName.get(normalise(row.name));
      if (!existing) continue;
      await repository.updateMenuItem(businessId, existing.id, {
        priceCents: row.priceCents,
        ...(categoryId ? { categoryId } : {}),
        // A description is only ever added, never blanked: the paste may
        // simply not have carried one, and wiping the copy somebody wrote
        // by hand is not what "import my menu" means.
        ...(row.description ? { description: row.description } : {}),
      });
    }
  }

  return { dryRun: false, rows, newCategories, unparsed: parsed.unparsed, counts };
}
