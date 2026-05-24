-- Phase 4 / Scenario B: SQL helper used by the bulk UPDATE inside
-- MaterializationService. Mirrors the TypeScript computeEffectivePrice() in
-- src/domain/effective-price.ts:
--
--   * PERCENTAGE: base_price * (1 - discount_value / 100)
--   * FIXED_AMOUNT: base_price - discount_value
--   * Floor at 0, round HALF_UP at 2 decimal places.
--
-- Marked IMMUTABLE so the planner can inline it inside set-based UPDATEs.
-- For positive numerics Postgres ROUND(NUMERIC, int) rounds half-away-from-zero
-- which is the same as HALF_UP — money is always non-negative here.
CREATE OR REPLACE FUNCTION compute_effective_price(
  base_price       NUMERIC,
  d_type           "DiscountType",
  d_value          NUMERIC
) RETURNS NUMERIC AS $$
  SELECT GREATEST(
    ROUND(
      CASE
        WHEN d_type = 'PERCENTAGE'   THEN base_price * (1 - d_value / 100)
        WHEN d_type = 'FIXED_AMOUNT' THEN base_price - d_value
      END,
      2
    ),
    0
  )::NUMERIC(12, 2);
$$ LANGUAGE SQL IMMUTABLE;
