import {
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma, type Promotion } from '@prisma/client';
import { CacheService } from '../cache/cache.service';
import { computeEffectivePrice } from '../domain/effective-price';
import {
  detectPromotionConflict,
  isLive,
  pickWinningPromotion,
  type PromotionLike,
} from '../domain/promotion-rules';
import { PrismaService } from '../infra/prisma.service';
import {
  presentPromotion,
  type CreatePromotionDto,
  type ListPromotionsQuery,
  type PromotionPresented,
} from './promotions.dto';
import { PromotionsRepository } from './promotions.repository';

interface LockedProduct {
  id: string;
  base_price: Prisma.Decimal;
  category_id: string;
  active_promotion_id: string | null;
}

@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PromotionsRepository,
    private readonly cache: CacheService,
  ) {}

  async getById(id: string): Promise<PromotionPresented> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`Promotion ${id} not found`);
    return presentPromotion(row);
  }

  async list(q: ListPromotionsQuery): Promise<PromotionPresented[]> {
    const rows = await this.repo.list(q);
    return rows.map(presentPromotion);
  }

  /**
   * Phase 3 — PRODUCT-scoped promotion creation only.
   *
   * Concurrency (plan §11): we open a transaction and `SELECT … FOR UPDATE`
   * the target product row. That serializes all concurrent promotion
   * creations against the same product without blocking unrelated work.
   *
   * Inside the lock we:
   *   1. Load every not-finished promotion already pointing at this product
   *      (directly via PRODUCT scope, or indirectly via CATEGORY scope on
   *      the product's category).
   *   2. Run `detectPromotionConflict` against the candidate window. If any
   *      live/scheduled promotion overlaps in time, return 409.
   *   3. Insert the promotion. If it should already be live, also create the
   *      product_promotions link row, flip status → ACTIVE, and bump the
   *      product's denormalized active_promotion_id + effective_price.
   *
   * CATEGORY scope is intentionally rejected in Phase 3 — materialization
   * (plan §9 / Phase 4) hasn't been built yet.
   */
  async create(dto: CreatePromotionDto): Promise<PromotionPresented> {
    if (dto.scope === 'CATEGORY') {
      throw new NotImplementedException(
        'CATEGORY-scoped promotions are wired up in Phase 4 (materialization).',
      );
    }

    const productId = dto.targetProductId!;
    const now = new Date();

    if (dto.endsAt.getTime() <= now.getTime()) {
      throw new ConflictException('endsAt must be in the future');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // 1. Row-level lock on the product. Returns one row or none.
      const locked = await tx.$queryRaw<LockedProduct[]>`
        SELECT id, base_price, category_id, active_promotion_id
        FROM products
        WHERE id = ${productId}::uuid
        FOR UPDATE
      `;
      const product = locked[0];
      if (!product) throw new NotFoundException(`Product ${productId} not found`);

      // 2. Conflict detection. Any not-finished promotion that already
      //    applies to this product (directly OR via category).
      const existing = await tx.promotion.findMany({
        where: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          OR: [
            { scope: 'PRODUCT', targetProductId: productId },
            { scope: 'CATEGORY', targetCategoryId: product.category_id },
          ],
        },
      });

      const candidates: PromotionLike[] = existing.map(toPromotionLike);
      const conflict = detectPromotionConflict(candidates, {
        scope: 'PRODUCT',
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
      });
      if (conflict.conflicts) {
        throw new ConflictException({
          error: 'PromotionConflict',
          reason: conflict.reason,
          conflictingPromotionId: conflict.conflictingPromotionId,
          message:
            'An existing active or scheduled promotion already applies to this product for the requested time window.',
        });
      }

      // 3. Insert the promotion row.
      const initialStatus =
        dto.startsAt.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED';

      const promo = await tx.promotion.create({
        data: {
          name: dto.name,
          discountType: dto.discountType,
          discountValue: new Prisma.Decimal(dto.discountValue),
          scope: 'PRODUCT',
          targetProductId: productId,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          status: initialStatus,
        },
      });

      // Always record the (product, promotion) link — this is the
      // materialized table that Scenario B (Phase 4) leans on.
      await tx.productPromotion.create({
        data: { productId, promotionId: promo.id },
      });

      // If the promotion is already live, push it through to the product's
      // denormalized read-view fields. The PRODUCT-scope precedence rule
      // means this beats any live CATEGORY promotion automatically.
      if (initialStatus === 'ACTIVE') {
        const effective = computeEffectivePrice(product.base_price.toString(), {
          discountType: promo.discountType,
          discountValue: promo.discountValue.toString(),
        });
        await tx.product.update({
          where: { id: productId },
          data: {
            activePromotionId: promo.id,
            effectivePrice: new Prisma.Decimal(effective.toString()),
            effectivePriceUpdatedAt: now,
          },
        });
      }

      return promo;
    });

    // Cache invalidation runs AFTER commit. Logged on failure, never thrown.
    await this.cache.invalidateProducts([productId]);
    return presentPromotion(created);
  }

  /**
   * Cancel a promotion. Sets status=CANCELLED and, for every product whose
   * `active_promotion_id` was this one, re-evaluates the read-view: pick the
   * next winner among remaining live promotions, or fall back to base_price.
   *
   * The query is generic over scope — Phase 4's bulk-affected category
   * promotion will exercise the multi-product path. In Phase 3 it'll be at
   * most one product per cancellation.
   */
  async cancel(id: string): Promise<PromotionPresented> {
    const now = new Date();
    const affectedProductIds: string[] = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.findUnique({ where: { id } });
      if (!promo) throw new NotFoundException(`Promotion ${id} not found`);
      if (promo.status === 'CANCELLED') {
        throw new ConflictException('Promotion is already cancelled');
      }

      const cancelled = await tx.promotion.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      // Find every product currently pointing at this promotion. Lock them
      // for update so concurrent reads can't race against our recompute.
      const products = await tx.$queryRaw<LockedProduct[]>`
        SELECT id, base_price, category_id, active_promotion_id
        FROM products
        WHERE active_promotion_id = ${id}::uuid
        FOR UPDATE
      `;

      for (const product of products) {
        affectedProductIds.push(product.id);

        // Re-evaluate the precedence rule on what's still live.
        const remaining = await tx.promotion.findMany({
          where: {
            id: { not: id },
            status: { in: ['ACTIVE', 'SCHEDULED'] },
            OR: [
              { scope: 'PRODUCT', targetProductId: product.id },
              { scope: 'CATEGORY', targetCategoryId: product.category_id },
            ],
          },
        });

        const winner = pickWinningPromotion(remaining.map(toPromotionLike), now);
        const liveWinner = winner && isLive(winner, now) ? winner : null;

        let effective: string;
        let nextPromotionId: string | null = null;

        if (liveWinner) {
          const promoRow = remaining.find((r) => r.id === liveWinner.id)!;
          effective = computeEffectivePrice(product.base_price.toString(), {
            discountType: promoRow.discountType,
            discountValue: promoRow.discountValue.toString(),
          }).toString();
          nextPromotionId = liveWinner.id;
        } else {
          effective = product.base_price.toString();
        }

        await tx.product.update({
          where: { id: product.id },
          data: {
            activePromotionId: nextPromotionId,
            effectivePrice: new Prisma.Decimal(effective),
            effectivePriceUpdatedAt: now,
          },
        });
      }

      return cancelled;
    });

    if (affectedProductIds.length > 0) {
      await this.cache.invalidateProducts(affectedProductIds);
    }
    return presentPromotion(updated);
  }
}

function toPromotionLike(p: Promotion): PromotionLike {
  return {
    id: p.id,
    scope: p.scope,
    status: p.status,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    createdAt: p.createdAt,
  };
}
