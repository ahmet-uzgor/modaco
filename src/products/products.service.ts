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

  async create(dto: CreateProductDto): Promise<ProductPresented> {
    const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
    if (!category) throw new BadRequestException(`Category ${dto.categoryId} does not exist`);

    // Phase 3: no auto-apply of category promotions yet. Effective price = base
    // price. Phase 4 will wrap this in a transaction that also materializes
    // the link to any live category-scoped promotion.
    try {
      const created = await this.prisma.product.create({
        data: {
          sku: dto.sku,
          name: dto.name,
          categoryId: dto.categoryId,
          basePrice: new Prisma.Decimal(dto.basePrice),
          stockQuantity: dto.stockQuantity,
          effectivePrice: new Prisma.Decimal(dto.basePrice),
        },
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
