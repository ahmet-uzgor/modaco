import {
  detectPromotionConflict,
  isLive,
  pickWinningPromotion,
  windowsOverlap,
  type PromotionLike,
} from './promotion-rules';

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-02T00:00:00Z');
const T2 = new Date('2026-01-03T00:00:00Z');
const T3 = new Date('2026-01-04T00:00:00Z');

function promo(
  overrides: Partial<PromotionLike> & Pick<PromotionLike, 'id' | 'scope'>,
): PromotionLike {
  return {
    status: 'ACTIVE',
    startsAt: T0,
    endsAt: T3,
    ...overrides,
  };
}

describe('isLive()', () => {
  const p = promo({ id: 'p1', scope: 'PRODUCT', startsAt: T1, endsAt: T2 });

  it('true at startsAt boundary (inclusive)', () => {
    expect(isLive(p, T1)).toBe(true);
  });

  it('false at endsAt boundary (exclusive)', () => {
    expect(isLive(p, T2)).toBe(false);
  });

  it('false before window', () => {
    expect(isLive(p, T0)).toBe(false);
  });

  it.each(['CANCELLED', 'EXPIRED'] as const)('false when status is %s', (status) => {
    expect(isLive({ ...p, status }, T1)).toBe(false);
  });

  it('true for SCHEDULED promotions whose window has opened', () => {
    expect(isLive({ ...p, status: 'SCHEDULED' }, T1)).toBe(true);
  });
});

describe('windowsOverlap()', () => {
  it('true when one window is inside the other', () => {
    expect(windowsOverlap({ startsAt: T0, endsAt: T3 }, { startsAt: T1, endsAt: T2 })).toBe(true);
  });

  it('false for back-to-back windows (end-exclusive)', () => {
    expect(windowsOverlap({ startsAt: T0, endsAt: T1 }, { startsAt: T1, endsAt: T2 })).toBe(false);
  });

  it('true for partially overlapping windows', () => {
    expect(windowsOverlap({ startsAt: T0, endsAt: T2 }, { startsAt: T1, endsAt: T3 })).toBe(true);
  });

  it('false for fully disjoint windows', () => {
    expect(windowsOverlap({ startsAt: T0, endsAt: T1 }, { startsAt: T2, endsAt: T3 })).toBe(false);
  });
});

describe('pickWinningPromotion() — precedence', () => {
  it('returns null when no candidates are live', () => {
    expect(
      pickWinningPromotion([promo({ id: 'a', scope: 'PRODUCT', status: 'CANCELLED' })], T1),
    ).toBeNull();
  });

  it('PRODUCT scope outranks CATEGORY scope when both are live', () => {
    const winner = pickWinningPromotion(
      [promo({ id: 'category', scope: 'CATEGORY' }), promo({ id: 'product', scope: 'PRODUCT' })],
      T1,
    );
    expect(winner?.id).toBe('product');
  });

  it('returns the category promotion when only category is live', () => {
    const winner = pickWinningPromotion([promo({ id: 'cat', scope: 'CATEGORY' })], T1);
    expect(winner?.id).toBe('cat');
  });

  it('tiebreaks by most-recently-created within the same scope', () => {
    const older = promo({ id: 'older', scope: 'PRODUCT', createdAt: T0 });
    const newer = promo({ id: 'newer', scope: 'PRODUCT', createdAt: T1 });
    expect(pickWinningPromotion([older, newer], T2)?.id).toBe('newer');
    expect(pickWinningPromotion([newer, older], T2)?.id).toBe('newer');
  });
});

describe('detectPromotionConflict()', () => {
  const productLive = promo({
    id: 'existing-product',
    scope: 'PRODUCT',
    startsAt: T1,
    endsAt: T3,
  });

  it('reports no conflict against an empty existing set', () => {
    expect(detectPromotionConflict([], { scope: 'PRODUCT', startsAt: T0, endsAt: T1 })).toEqual({
      conflicts: false,
    });
  });

  it('flags overlap with an existing PRODUCT-scoped promotion', () => {
    const res = detectPromotionConflict([productLive], {
      scope: 'PRODUCT',
      startsAt: T2,
      endsAt: T3,
    });
    expect(res).toEqual({
      conflicts: true,
      reason: 'EXISTING_PRODUCT_PROMOTION',
      conflictingPromotionId: 'existing-product',
    });
  });

  it('flags overlap with an existing CATEGORY-scoped promotion', () => {
    const categoryLive = promo({
      id: 'existing-cat',
      scope: 'CATEGORY',
      startsAt: T1,
      endsAt: T3,
    });
    const res = detectPromotionConflict([categoryLive], {
      scope: 'PRODUCT',
      startsAt: T2,
      endsAt: T3,
    });
    expect(res).toEqual({
      conflicts: true,
      reason: 'EXISTING_CATEGORY_PROMOTION',
      conflictingPromotionId: 'existing-cat',
    });
  });

  it('ignores CANCELLED and EXPIRED existing promotions', () => {
    expect(
      detectPromotionConflict(
        [
          promo({
            id: 'cancelled',
            scope: 'PRODUCT',
            status: 'CANCELLED',
            startsAt: T1,
            endsAt: T3,
          }),
          promo({ id: 'expired', scope: 'PRODUCT', status: 'EXPIRED', startsAt: T1, endsAt: T3 }),
        ],
        { scope: 'PRODUCT', startsAt: T1, endsAt: T2 },
      ),
    ).toEqual({ conflicts: false });
  });

  it('reports no conflict when windows are back-to-back', () => {
    expect(
      detectPromotionConflict([productLive], {
        scope: 'PRODUCT',
        startsAt: T3, // existing ends at T3, new starts at T3 — end-exclusive
        endsAt: new Date('2026-01-05T00:00:00Z'),
      }),
    ).toEqual({ conflicts: false });
  });

  it('rejects a candidate whose window is empty or inverted', () => {
    expect(() =>
      detectPromotionConflict([], { scope: 'PRODUCT', startsAt: T2, endsAt: T1 }),
    ).toThrow();
  });
});
