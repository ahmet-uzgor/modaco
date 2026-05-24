import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { PricingRuleViolation, applyPricingRules } from './pricing-rules';
import { RawIngestRowSchema, type NormalizedIngestRow } from './row.schema';

export interface ChunkResult {
  okCount: number;
  failedCount: number;
}

interface RowResult {
  rowKey: string;
  status: 'OK' | 'FAILED';
  errorMessage: string | null;
}

/**
 * Processes a chunk of rows from a vendor ingest batch.
 *
 * The pipeline per row is:
 *   1. Zod-validate the wire shape.
 *   2. Apply dynamic pricing rules (margin floor, normalisation).
 *   3. If either step fails → record FAILED in ingest_row_results,
 *      keep the chunk alive (partial failures are normal).
 *
 * Then for every row that survived, we:
 *   4. Resolve / upsert categories by name in one round trip.
 *   5. Bulk INSERT … ON CONFLICT (sku) DO UPDATE in a single statement.
 *      No 500-row for-loop with await — one query per chunk.
 *
 * Idempotency story (plan §8):
 *   - (batch_id, row_key) is the PK on ingest_row_results, so reprocessing
 *     the same chunk doesn't duplicate rows. ON CONFLICT DO UPDATE on
 *     (batch_id, row_key) refreshes the status if it was previously
 *     FAILED.
 *   - sku is the unique key on products, so ON CONFLICT (sku) DO UPDATE
 *     makes the product write itself idempotent. effective_price is
 *     re-evaluated against any currently-active promotion via
 *     compute_effective_price(); promotion ownership of the read view
 *     stays intact even when ingest changes the base_price.
 *   - ingest_batches.processed_rows / failed_rows are incremented atomically
 *     with the chunk so a retry against the same chunk doesn't double-count.
 */
@Injectable()
export class IngestProcessor {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async processChunk(batchId: string, rawRows: readonly unknown[]): Promise<ChunkResult> {
    const startedAt = Date.now();
    const results: RowResult[] = [];
    const valid: NormalizedIngestRow[] = [];

    for (const raw of rawRows) {
      const rowKey = pickRowKey(raw);
      const parsed = RawIngestRowSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          rowKey,
          status: 'FAILED',
          errorMessage: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        });
        continue;
      }
      try {
        valid.push(applyPricingRules(parsed.data));
        results.push({ rowKey: parsed.data.sku, status: 'OK', errorMessage: null });
      } catch (err) {
        results.push({
          rowKey: parsed.data.sku,
          status: 'FAILED',
          errorMessage:
            err instanceof PricingRuleViolation ? `${err.rule}: ${err.message}` : String(err),
        });
      }
    }

    const okRows = valid;
    const okCount = okRows.length;
    const failedCount = results.length - okCount;

    await this.prisma.$transaction(async (tx) => {
      if (okRows.length > 0) {
        const categoryIdByName = await this.resolveCategories(tx, okRows);
        await this.bulkUpsertProducts(tx, okRows, categoryIdByName);
      }
      await this.recordRowResults(tx, batchId, results);
      await tx.ingestBatch.update({
        where: { id: batchId },
        data: {
          processedRows: { increment: okCount },
          failedRows: { increment: failedCount },
        },
      });
    });

    this.logger.log(
      {
        batchId,
        rows: rawRows.length,
        okCount,
        failedCount,
        durationMs: Date.now() - startedAt,
      },
      'ingest chunk processed',
    );

    return { okCount, failedCount };
  }

  private async resolveCategories(
    tx: Prisma.TransactionClient,
    rows: readonly NormalizedIngestRow[],
  ): Promise<Map<string, string>> {
    const uniqueNames = Array.from(new Set(rows.map((r) => r.categoryName)));

    const existing = await tx.category.findMany({
      where: { name: { in: uniqueNames } },
    });
    const map = new Map(existing.map((c) => [c.name, c.id]));

    const missing = uniqueNames.filter((n) => !map.has(n));
    if (missing.length > 0) {
      // createMany with skipDuplicates so concurrent ingest batches that
      // both see the same missing category don't both fail the unique
      // constraint.
      await tx.category.createMany({
        data: missing.map((name) => ({ name })),
        skipDuplicates: true,
      });
      const fresh = await tx.category.findMany({ where: { name: { in: missing } } });
      for (const c of fresh) map.set(c.name, c.id);
    }
    return map;
  }

  private async bulkUpsertProducts(
    tx: Prisma.TransactionClient,
    rows: readonly NormalizedIngestRow[],
    categoryIdByName: Map<string, string>,
  ): Promise<void> {
    const skus = rows.map((r) => r.sku);
    const names = rows.map((r) => r.name);
    const categoryIds = rows.map((r) => categoryIdByName.get(r.categoryName)!);
    const basePrices = rows.map((r) => r.basePrice);
    const stocks = rows.map((r) => r.stockQuantity);

    // One statement. UNNEST aligns the parallel arrays into rows. The
    // ON CONFLICT branch defers effective_price to the SQL helper added
    // in Phase 4 so a still-live category promo keeps its grip on the
    // read view even when ingest changes the base_price.
    await tx.$executeRaw`
      INSERT INTO products (
        sku, name, category_id, base_price, stock_quantity,
        effective_price, effective_price_updated_at, created_at, updated_at
      )
      SELECT
        sku, name, category_id, base_price, stock_qty,
        base_price, now(), now(), now()
      FROM UNNEST(
        ${skus}::text[],
        ${names}::text[],
        ${categoryIds}::uuid[],
        ${basePrices}::numeric[],
        ${stocks}::int[]
      ) AS src(sku, name, category_id, base_price, stock_qty)
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name,
        category_id = EXCLUDED.category_id,
        base_price = EXCLUDED.base_price,
        stock_quantity = EXCLUDED.stock_quantity,
        effective_price = COALESCE(
          (SELECT compute_effective_price(EXCLUDED.base_price, p.discount_type, p.discount_value)
           FROM promotions p
           WHERE p.id = products.active_promotion_id
             AND p.status = 'ACTIVE'
             AND p.starts_at <= now()
             AND p.ends_at > now()
           LIMIT 1),
          EXCLUDED.base_price
        ),
        effective_price_updated_at = now(),
        updated_at = now()
    `;
  }

  private async recordRowResults(
    tx: Prisma.TransactionClient,
    batchId: string,
    results: readonly RowResult[],
  ): Promise<void> {
    if (results.length === 0) return;

    const batchIds = results.map(() => batchId);
    const rowKeys = results.map((r) => r.rowKey);
    const statuses = results.map((r) => r.status);
    // Empty-string sentinel: Prisma's parameter binding for text[] mishandles
    // arrays that mix null and string ("improper binary format"). We
    // round-trip null as '' through the array and convert back via NULLIF
    // before the INSERT actually lands.
    const errors = results.map((r) => r.errorMessage ?? '');

    await tx.$executeRaw`
      INSERT INTO ingest_row_results (batch_id, row_key, status, error_message, processed_at)
      SELECT batch_id::uuid, row_key, status, NULLIF(error_message, '') AS error_message, now()
      FROM UNNEST(
        ${batchIds}::text[],
        ${rowKeys}::text[],
        ${statuses}::text[],
        ${errors}::text[]
      ) AS src(batch_id, row_key, status, error_message)
      ON CONFLICT (batch_id, row_key) DO UPDATE SET
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        processed_at = now()
    `;
  }
}

function pickRowKey(raw: unknown): string {
  if (raw !== null && typeof raw === 'object' && 'sku' in raw) {
    const sku = (raw as { sku: unknown }).sku;
    if (typeof sku === 'string' && sku.length > 0) return sku;
  }
  return `unknown-${Math.random().toString(36).slice(2, 10)}`;
}
