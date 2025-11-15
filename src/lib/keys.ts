/**
 * Key construction for the single-table design in {@link LinksTable}.
 *
 * Everything lives in one table, so the key layouts are the schema. Keeping
 * them in one module means the access patterns and the indexes that serve them
 * are read in the same place.
 */

/** Sort key of the metadata item for a link. */
export const LINK_SORT_KEY = 'META';

/** Primary key of a link's metadata item. */
export function linkKey(code: string): { pk: string; sk: string } {
  return { pk: `LINK#${code}`, sk: LINK_SORT_KEY };
}

/** Keys of the owner index (`gsi1`), sorted by creation time. */
export function ownerIndexKeys(
  ownerId: string,
  createdAt: string,
): { gsi1pk: string; gsi1sk: string } {
  return { gsi1pk: `OWNER#${ownerId}`, gsi1sk: createdAt };
}

/**
 * Key of the URL index (`gsi2`). This is what makes creating a link idempotent:
 * the same long URL resolves to the same short code instead of a new one.
 */
export function urlIndexKey(urlHash: string): { gsi2pk: string } {
  return { gsi2pk: `URL#${urlHash}` };
}

/** Primary key of one click record. Click items share the link's partition. */
export function clickKey(code: string, at: string, id: string): { pk: string; sk: string } {
  return { pk: `LINK#${code}`, sk: `CLICK#${at}#${id}` };
}
