/**
 * Cursor-based pagination helpers.
 *
 * Plan §7 prefers cursors over offset/limit because offsets are slow over
 * large filtered sets and unstable when the underlying sort field is mutable
 * (which `effective_price` very much is).
 *
 * A cursor encodes (sortValue, id) so the keyset query is fully ordered:
 *   ORDER BY <sortField>, id        — deterministic tiebreak by uuid
 *   WHERE (<sortField>, id) > (<sortValue>, <id>)   for ASC
 *
 * Cursors are base64url-encoded so they're URL-safe and opaque to clients —
 * we can change the internal format without breaking the wire contract.
 */

export const PAGINATION = {
  defaultLimit: 20,
  maxLimit: 100,
} as const;

export type SortDirection = 'asc' | 'desc';

export interface DecodedCursor {
  sortValue: string;
  id: string;
}

export function encodeCursor(sortValue: string, id: string): string {
  const payload = JSON.stringify({ s: sortValue, i: id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { s?: unknown }).s === 'string' &&
      typeof (parsed as { i?: unknown }).i === 'string'
    ) {
      return { sortValue: (parsed as { s: string }).s, id: (parsed as { i: string }).i };
    }
    return null;
  } catch {
    return null;
  }
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}
