import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
import { JobRunner } from '../jobs/job-runner.service';
import { MaterializationService } from './materialization.service';
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
    private readonly materialization: MaterializationService,
    private readonly jobs: JobRunner,
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

  async create(dto: CreatePromotionDto): Promise<PromotionPresented> {
    if (dto.endsAt.getTime() <= Date.now()) {
      throw new ConflictException('endsAt must be in the future');
    }
    return dto.scope === 'CATEGORY'
      ? this.createCategoryPromotion(dto)
      : this.createProductPromotion(dto);
  }

  /**
   * Phase 3 path — PRODUCT-scoped promotion creation.
   *
   * Concurrency (plan §11): we open a transaction and SELECT … FOR UPDATE
   * the target product row. That serializes concurrent promotion creations
   * against the same product without blocking unrelated work.
   */
  private async createProductPromotion(dto: CreatePromotionDto): Promise<PromotionPresented> {
    const productId = dto.targetProductId!;
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<LockedProduct[]>`
        SELECT id, base_price, category_id, active_promotion_id
        FROM products
        WHERE id = ${productId}::uuid
        FOR UPDATE
      `;
      const product = locked[0];
      if (!product) throw new NotFoundException(`Product ${productId} not found`);

      const existing = await tx.promotion.findMany({
        where: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          OR: [
            { scope: 'PRODUCT', targetProductId: productId },
            { scope: 'CATEGORY', targetCategoryId: product.category_id },
          ],
        },
      });

      const conflict = detectPromotionConflict(existing.map(toPromotionLike), {
        scope: 'PRODUCT',
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
      });
      if (conflict.conflicts) {
        throw new ConflictException(conflictPayload(conflict));
      }

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

      await tx.productPromotion.create({
        data: { productId, promotionId: promo.id },
      });

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

    await this.cache.invalidateProducts([productId]);
    return presentPromotion(created);
  }

  /**
   * Phase 4 path — CATEGORY-scoped promotion creation. Returns immediately
   * (the controller renders 202 Accepted) and hands the heavy bulk SQL off
   * to MaterializationService via JobRunner.
   *
   * Concurrency: advisory lock on the category prevents two overlapping
   * category promotions from being inserted at the same time. The conflict
   * check then guards against logical overlap.
   */
  private async createCategoryPromotion(dto: CreatePromotionDto): Promise<PromotionPresented> {
    const categoryId = dto.targetCategoryId!;
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`category:${categoryId}`}))
      `;

      const category = await tx.category.findUnique({ where: { id: categoryId } });
      if (!category) throw new NotFoundException(`Category ${categoryId} not found`);

      const existing = await tx.promotion.findMany({
        where: {
          scope: 'CATEGORY',
          targetCategoryId: categoryId,
          status: { in: ['ACTIVE', 'SCHEDULED'] },
        },
      });

      const conflict = detectPromotionConflict(existing.map(toPromotionLike), {
        scope: 'CATEGORY',
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
      });
      if (conflict.conflicts) {
        throw new ConflictException(conflictPayload(conflict));
      }

      const initialStatus =
        dto.startsAt.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED';

      return tx.promotion.create({
        data: {
          name: dto.name,
          discountType: dto.discountType,
          discountValue: new Prisma.Decimal(dto.discountValue),
          scope: 'CATEGORY',
          targetCategoryId: categoryId,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          status: initialStatus,
        },
      });
    });

    // Materialization is the heavy bulk SQL — runs in background. Only fire
    // it for promotions that are live RIGHT NOW. Scheduled-future promos
    // would need a wake-up trigger at startsAt; out of scope for the case
    // study (documented in ADR).
    if (created.status === 'ACTIVE') {
      this.jobs.enqueue(`apply-category:${created.id}`, async () => {
        await this.materialization.applyCategoryPromotion(created.id);
      });
    }

    return presentPromotion(created);
  }

  async cancel(id: string): Promise<PromotionPresented> {
    const promo = await this.repo.findById(id);
    if (!promo) throw new NotFoundException(`Promotion ${id} not found`);
    if (promo.status === 'CANCELLED') {
      throw new ConflictException('Promotion is already cancelled');
    }
    return promo.scope === 'CATEGORY' ? this.cancelCategory(id) : this.cancelProduct(id);
  }

  /**
   * PRODUCT-scope cancel: at most one product to revisit, so we re-evaluate
   * the precedence rule against any remaining live promotions and write the
   * next state in the same transaction.
   */
  private async cancelProduct(id: string): Promise<PromotionPresented> {
    const now = new Date();
    const affectedProductIds: string[] = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.promotion.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      const products = await tx.$queryRaw<LockedProduct[]>`
        SELECT id, base_price, category_id, active_promotion_id
        FROM products
        WHERE active_promotion_id = ${id}::uuid
        FOR UPDATE
      `;

      for (const product of products) {
        affectedProductIds.push(product.id);

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

  /**
   * CATEGORY-scope cancel: flips the status row and hands off to
   * MaterializationService for the bulk UPDATE. Done synchronously so the
   * HTTP response is only sent once products reflect the revert — for the
   * case-study scale (1k–50k products) the bulk SQL stays well under a
   * second, and immediate consistency is more useful than another 202.
   */
  private async cancelCategory(id: string): Promise<PromotionPresented> {
    const cancelled = await this.prisma.promotion.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.materialization.revertCategoryPromotion(id);
    return presentPromotion(cancelled);
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

function conflictPayload(conflict: {
  reason: string;
  conflictingPromotionId: string;
}): Record<string, unknown> {
  return {
    error: 'PromotionConflict',
    reason: conflict.reason,
    conflictingPromotionId: conflict.conflictingPromotionId,
    message:
      'An existing active or scheduled promotion already applies to this target for the requested time window.',
  };
}
