/**
 * Pure domain logic for the "one active promotion per product" rules:
 *
 *  - **Precedence** (plan §6): if both a PRODUCT-scoped and a CATEGORY-scoped
 *    promotion are live for the same product, the PRODUCT one wins; the
 *    category one is suppressed for that product until the product one ends.
 *
 *  - **Conflict policy** (plan §11): when a new promotion would land on a
 *    product that already has *any* live promotion that would also apply to
 *    that product, creation is rejected (HTTP 409). We do not silently
 *    override. Callers must explicitly cancel the existing one first.
 *
 * This module has no I/O. Repositories load candidate rows, then call these
 * helpers. Read-time selection (precedence) and write-time validation
 * (conflict) share the same definitions so the two paths can't drift.
 */

export type PromotionScope = 'PRODUCT' | 'CATEGORY';
export type PromotionStatus = 'SCHEDULED' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';

export interface PromotionLike {
  id: string;
  scope: PromotionScope;
  status: PromotionStatus;
  startsAt: Date;
  endsAt: Date;
  // When two promotions of the same scope overlap, the most-recently-created
  // one wins. Optional so tests can omit it when not relevant.
  createdAt?: Date;
}

/**
 * A promotion is "live" at instant `at` when its status is ACTIVE/SCHEDULED
 * and `at` falls inside [startsAt, endsAt). End is exclusive so back-to-back
 * promotions don't both fire at the boundary.
 */
export function isLive(p: PromotionLike, at: Date = new Date()): boolean {
  if (p.status !== 'ACTIVE' && p.status !== 'SCHEDULED') return false;
  const t = at.getTime();
  return p.startsAt.getTime() <= t && t < p.endsAt.getTime();
}

/** Time-window overlap test, end-exclusive (matches `isLive` semantics). */
export function windowsOverlap(
  a: { startsAt: Date; endsAt: Date },
  b: { startsAt: Date; endsAt: Date },
): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/**
 * Apply the precedence rule. Returns the single promotion that "wins" for a
 * product at instant `at`, or null if none are live.
 *
 *   PRODUCT scope always outranks CATEGORY scope.
 *   Within the same scope, the most-recently-created wins (deterministic
 *   tiebreak; in practice the schema enforces at-most-one).
 */
export function pickWinningPromotion<T extends PromotionLike>(
  candidates: readonly T[],
  at: Date = new Date(),
): T | null {
  const live = candidates.filter((p) => isLive(p, at));
  if (live.length === 0) return null;

  const productLevel = live.filter((p) => p.scope === 'PRODUCT');
  const pool = productLevel.length > 0 ? productLevel : live;

  // Sort by createdAt desc; entries without createdAt go last.
  const sorted = [...pool].sort((x, y) => {
    const xc = x.createdAt?.getTime() ?? -Infinity;
    const yc = y.createdAt?.getTime() ?? -Infinity;
    return yc - xc;
  });
  return sorted[0] ?? null;
}

export type ConflictReason =
  | 'EXISTING_PRODUCT_PROMOTION'
  | 'EXISTING_CATEGORY_PROMOTION'
  | 'EXISTING_PROMOTION';

export interface ConflictHit {
  conflicts: true;
  reason: ConflictReason;
  conflictingPromotionId: string;
}

export interface ConflictMiss {
  conflicts: false;
}

export type ConflictResult = ConflictHit | ConflictMiss;

export interface CandidatePromotion {
  scope: PromotionScope;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Detect whether a candidate promotion conflicts with any existing
 * not-yet-finished promotion already applying to the same product (directly
 * or via its category).
 *
 * Existing promotions in CANCELLED or EXPIRED state are ignored. Time overlap
 * with the candidate's [startsAt, endsAt) window is what triggers the
 * conflict — not just "live right now", because a SCHEDULED promotion can
 * still collide with a new one whose window overlaps it.
 */
export function detectPromotionConflict(
  existing: readonly PromotionLike[],
  candidate: CandidatePromotion,
): ConflictResult {
  if (candidate.endsAt.getTime() <= candidate.startsAt.getTime()) {
    // Defensive: schema CHECK enforces this too, but the caller may not have
    // validated yet.
    throw new Error('candidate.endsAt must be after candidate.startsAt');
  }

  for (const e of existing) {
    if (e.status !== 'ACTIVE' && e.status !== 'SCHEDULED') continue;
    if (!windowsOverlap(e, candidate)) continue;
    return {
      conflicts: true,
      reason: e.scope === 'PRODUCT' ? 'EXISTING_PRODUCT_PROMOTION' : 'EXISTING_CATEGORY_PROMOTION',
      conflictingPromotionId: e.id,
    };
  }
  return { conflicts: false };
}
