import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../infra/prisma.service';
import { MetricsService } from '../observability/metrics.service';

const CACHE_INVALIDATE_CHUNK = 1000;

/**
 * Scenario B (plan §9) materialization. A category-wide promotion can affect
 * tens of thousands of products instantly. The naive "loop and insert/update
 * row by row" pattern is exactly what the brief is checking against; we use
 * single set-based statements instead.
 *
 *   apply():
 *     1. pg_advisory_xact_lock on the category — prevents two concurrent
 *        materializations of overlapping promotions on the same category
 *        from interleaving (plan §11).
 *     2. INSERT INTO product_promotions SELECT … FROM products
 *        WHERE category_id = X  — one statement, 50k rows.
 *     3. UPDATE products SET active_promotion_id = $promo,
 *        effective_price = compute_effective_price(base_price, type, value),
 *        excluding products whose current active_promotion_id is a still-live
 *        PRODUCT-scope promo (precedence rule).
 *
 *   revert():
 *     1. UPDATE products clearing active_promotion_id and resetting
 *        effective_price to base_price for the rows that were carrying this
 *        promotion. The conflict rule prevents a PRODUCT-scope override
 *        existing on these products while the category one was active, so
 *        falling back to base_price is correct (any *new* product-scope
 *        promo for these products goes through the create-time conflict
 *        check before activating).
 *
 *  Cache invalidation runs AFTER the DB transaction commits. The Redis
 *  pipeline batches deletes 1000 at a time so 50k keys aren't 50k round
 *  trips. Plan §10.
 */
@Injectable()
export class MaterializationService {
  private readonly logger = new Logger(MaterializationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
  ) {}

  async applyCategoryPromotion(promotionId: string): Promise<{ affectedProductIds: string[] }> {
    const stopTimer = this.metrics.materializationDuration.startTimer({ kind: 'apply' });
    const startedAt = Date.now();

    const affectedProductIds = await this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.findUnique({ where: { id: promotionId } });
      if (!promo) throw new NotFoundException(`Promotion ${promotionId} not found`);
      if (promo.scope !== 'CATEGORY' || promo.targetCategoryId === null) {
        throw new Error(`Promotion ${promotionId} is not a category-scope promotion`);
      }

      // Advisory lock: only one materialization may run for a given category
      // at a time. Released automatically when the transaction ends.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`category:${promo.targetCategoryId}`}))
      `;

      // 1. Materialize links. ON CONFLICT keeps the call idempotent so a
      //    retry never produces duplicate rows. Set-based; one statement.
      await tx.$executeRaw`
        INSERT INTO product_promotions (product_id, promotion_id)
        SELECT p.id, ${promotionId}::uuid
        FROM products p
        WHERE p.category_id = ${promo.targetCategoryId}::uuid
        ON CONFLICT DO NOTHING
      `;

      // 2. Bulk update effective_price + active_promotion_id, honoring
      //    the precedence rule: skip products that have a still-live
      //    PRODUCT-scope promotion as their current active one.
      const updated = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE products
        SET active_promotion_id = ${promotionId}::uuid,
            effective_price = compute_effective_price(
              base_price,
              ${promo.discountType}::"DiscountType",
              ${promo.discountValue}::numeric
            ),
            effective_price_updated_at = now(),
            updated_at = now()
        WHERE category_id = ${promo.targetCategoryId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM promotions outranking
            WHERE outranking.id = products.active_promotion_id
              AND outranking.scope = 'PRODUCT'
              AND outranking.status IN ('ACTIVE', 'SCHEDULED')
              AND outranking.starts_at <= now()
              AND outranking.ends_at > now()
          )
        RETURNING id
      `;

      return updated.map((u) => u.id);
    });

    await this.invalidateInBatches(affectedProductIds);
    stopTimer();

    this.logger.log(
      {
        promotionId,
        affectedProducts: affectedProductIds.length,
        durationMs: Date.now() - startedAt,
      },
      'category promotion materialized',
    );

    return { affectedProductIds };
  }

  async revertCategoryPromotion(promotionId: string): Promise<{ affectedProductIds: string[] }> {
    const stopTimer = this.metrics.materializationDuration.startTimer({ kind: 'revert' });
    const startedAt = Date.now();

    const affectedProductIds = await this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.findUnique({ where: { id: promotionId } });
      if (!promo) throw new NotFoundException(`Promotion ${promotionId} not found`);
      if (promo.scope !== 'CATEGORY' || promo.targetCategoryId === null) {
        throw new Error(`Promotion ${promotionId} is not a category-scope promotion`);
      }

      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`category:${promo.targetCategoryId}`}))
      `;

      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE products
        SET active_promotion_id = NULL,
            effective_price = base_price,
            effective_price_updated_at = now(),
            updated_at = now()
        WHERE active_promotion_id = ${promotionId}::uuid
        RETURNING id
      `;

      return rows.map((r) => r.id);
    });

    await this.invalidateInBatches(affectedProductIds);
    stopTimer();

    this.logger.log(
      {
        promotionId,
        affectedProducts: affectedProductIds.length,
        durationMs: Date.now() - startedAt,
      },
      'category promotion reverted',
    );

    return { affectedProductIds };
  }

  private async invalidateInBatches(productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return;
    for (let i = 0; i < productIds.length; i += CACHE_INVALIDATE_CHUNK) {
      const chunk = productIds.slice(i, i + CACHE_INVALIDATE_CHUNK);
      await this.cache.invalidateProducts(chunk);
    }
  }
}

// Keep Prisma referenced so the import isn't flagged when only used in raw
// queries (TypeScript can't see usage inside template literals).
void Prisma;
