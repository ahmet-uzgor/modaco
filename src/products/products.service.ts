import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CacheService, cacheKeys, cacheTtls } from '../cache/cache.service';
import { computeEffectivePrice } from '../domain/effective-price';
import { PrismaService } from '../infra/prisma.service';
import type { PageResult } from '../shared/pagination';
import {
  presentProduct,
  type CreateProductDto,
  type ListProductsQuery,
  type ProductPresented,
  type UpdateProductDto,
} from './products.dto';
import { ProductsRepository } from './products.repository';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ProductsRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * Cache-first detail read. Plan §10:
   *   1. GET product:{id} from Redis. Hit → return.
   *   2. Miss → read Postgres, SETEX with 5-minute TTL, return.
   * The TTL exists as a safety net; event-driven invalidation is primary.
   */
  async getById(id: string): Promise<ProductPresented> {
    const key = cacheKeys.product(id);
    const cached = await this.cache.getJson<ProductPresented>(key);
    if (cached) return cached;

    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`Product ${id} not found`);

    const presented = presentProduct(row);
    await this.cache.setJson(key, presented, cacheTtls.productDetailSec);
    return presented;
  }

  async list(q: ListProductsQuery): Promise<PageResult<ProductPresented>> {
    const page = await this.repo.list(q);
    return {
      data: page.data.map(presentProduct),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Create a product and — atomically with the insert — pick up any live
   * CATEGORY-scope promotion that applies to its category (plan §9, B2).
   *
   * The whole flow runs in one transaction so a newcomer can never observe
   * a state where the row exists at base price while a category-wide sale
   * is in progress. The check for an outranking PRODUCT-level promo is
   * unnecessary here: the product was just created.
   */
  async create(dto: CreateProductDto): Promise<ProductPresented> {
    const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
    if (!category) throw new BadRequestException(`Category ${dto.categoryId} does not exist`);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const now = new Date();

        // Find a live CATEGORY-scope promotion on this category. Most-recently
        // created wins if there were ever two (the conflict rule should
        // prevent that, but the ORDER BY makes the choice deterministic).
        const livePromo = await tx.promotion.findFirst({
          where: {
            scope: 'CATEGORY',
            targetCategoryId: dto.categoryId,
            status: { in: ['ACTIVE', 'SCHEDULED'] },
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        const effective = computeEffectivePrice(
          dto.basePrice,
          livePromo
            ? {
                discountType: livePromo.discountType,
                discountValue: livePromo.discountValue.toString(),
              }
            : null,
        );

        const product = await tx.product.create({
          data: {
            sku: dto.sku,
            name: dto.name,
            categoryId: dto.categoryId,
            basePrice: new Prisma.Decimal(dto.basePrice),
            stockQuantity: dto.stockQuantity,
            effectivePrice: new Prisma.Decimal(effective.toString()),
            effectivePriceUpdatedAt: now,
            ...(livePromo ? { activePromotionId: livePromo.id } : {}),
          },
        });

        // Always materialize the link row — it's the table Scenario B's
        // bulk operations key off, and `ON CONFLICT DO NOTHING` keeps the
        // future apply() call idempotent.
        if (livePromo) {
          await tx.productPromotion.create({
            data: { productId: product.id, promotionId: livePromo.id },
          });
        }

        return product;
      });
      return presentProduct(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Product with SKU "${dto.sku}" already exists`);
      }
      throw err;
    }
  }

  /**
   * Update name / base_price / stock. If base_price changed, recompute
   * effective_price against the currently-active promotion (if any) so the
   * denormalized read view stays in sync.
   */
  async update(id: string, dto: UpdateProductDto): Promise<ProductPresented> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id },
        include: { activePromotion: true },
      });
      if (!product) throw new NotFoundException(`Product ${id} not found`);

      const data: Prisma.ProductUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.stockQuantity !== undefined) data.stockQuantity = dto.stockQuantity;

      if (dto.basePrice !== undefined) {
        data.basePrice = new Prisma.Decimal(dto.basePrice);
        const promo = product.activePromotion
          ? {
              discountType: product.activePromotion.discountType,
              discountValue: product.activePromotion.discountValue.toString(),
            }
          : null;
        const effective = computeEffectivePrice(dto.basePrice, promo);
        data.effectivePrice = new Prisma.Decimal(effective.toString());
        data.effectivePriceUpdatedAt = new Date();
      }

      return tx.product.update({ where: { id }, data });
    });

    // Cache invalidation happens AFTER commit (plan §10). Failures here must
    // never roll back the DB write — TTL backstops us.
    await this.cache.invalidateProducts([id]);
    return presentProduct(updated);
  }
}
