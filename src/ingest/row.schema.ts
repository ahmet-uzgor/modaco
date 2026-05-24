import { z } from 'zod';

/**
 * The wire shape of one row in a vendor CSV. We intentionally validate at
 * the ingest boundary (just like the HTTP API does at its own boundary)
 * because vendor feeds drift over time and we want bad rows to be recorded
 * as FAILED row_results rather than silently corrupt data.
 *
 * CSV headers expected (case-insensitive on the producer side; csv-parse
 * normalises them):
 *
 *   sku            — required, used as the deterministic idempotency key
 *   name           — required
 *   category_name  — required; resolved to a Category row before insert
 *   base_price     — required, numeric (up to 2 decimals)
 *   vendor_cost    — optional, used by the margin-floor pricing rule
 *   stock_quantity — required, non-negative integer
 */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'expected a non-negative decimal with up to 2 fractional digits');

export const RawIngestRowSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  category_name: z.string().min(1).max(255),
  base_price: decimalString,
  vendor_cost: decimalString.optional(),
  stock_quantity: z.coerce.number().int().min(0),
});
export type RawIngestRow = z.infer<typeof RawIngestRowSchema>;

export interface NormalizedIngestRow {
  sku: string;
  name: string;
  categoryName: string;
  basePrice: string;
  stockQuantity: number;
}
