/**
 * All cache key builders live here so invalidation can use the same builders
 * the readers used. Untyped string literals scattered across services are how
 * cache invalidation bugs happen.
 */

export const cacheKeys = {
  product: (id: string): string => `product:${id}`,
  // List cache lives under a per-category namespace so we can invalidate just
  // the slice that's affected by a write. Phase 3 doesn't actually cache list
  // pages yet — these helpers exist for Phase 4 to drop in.
  productListNamespace: (categoryId: string | 'all'): string => `products:list:cat=${categoryId}`,
} as const;

export const cacheTtls = {
  productDetailSec: 300, // plan §10
  productListSec: 60,
} as const;
