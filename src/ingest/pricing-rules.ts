import { Decimal } from 'decimal.js';
import { money, toScale } from '../domain/money';
import type { NormalizedIngestRow, RawIngestRow } from './row.schema';

/**
 * Dynamic pricing rules applied to every ingest row (plan §8: "Every row
 * must pass through application-layer dynamic pricing rules before being
 * saved"). Kept pure and deterministic so the same row in two runs
 * produces the same output row — that's a precondition for idempotency.
 *
 * Two example rules; the brief doesn't pin down a specific set, so this is
 * a representative pair that exercises Decimal math:
 *
 *   1. Margin floor — if the vendor reports a wholesale cost, enforce
 *      base_price >= cost * (1 + MIN_MARGIN_PCT/100). Vendors sometimes
 *      ship feeds with stale prices below cost; we don't let those land.
 *
 *   2. Two-decimal normalisation — base_price rounded HALF_UP at 2 decimals,
 *      so downstream queries don't trip on 4-decimal vendor data.
 *
 * If a rule decides the row should be rejected outright we throw
 * PricingRuleViolation; the processor will record the row as FAILED.
 */

const MIN_MARGIN_PCT = 10;

export class PricingRuleViolation extends Error {
  constructor(
    public readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'PricingRuleViolation';
  }
}

export function applyPricingRules(row: RawIngestRow): NormalizedIngestRow {
  let basePrice = money(row.base_price);

  if (row.vendor_cost !== undefined) {
    const cost = money(row.vendor_cost);
    if (cost.isNegative()) {
      throw new PricingRuleViolation('VENDOR_COST_NEGATIVE', 'vendor_cost must be >= 0');
    }
    const floor = cost.times(new Decimal(1 + MIN_MARGIN_PCT / 100));
    if (basePrice.lt(floor)) {
      basePrice = floor;
    }
  }

  basePrice = toScale(basePrice);

  return {
    sku: row.sku,
    name: row.name,
    categoryName: row.category_name,
    basePrice: basePrice.toFixed(2),
    stockQuantity: row.stock_quantity,
  };
}
