import { Injectable } from '@nestjs/common';
import { Prisma, type Product } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { decodeCursor, encodeCursor, type SortDirection } from '../shared/pagination';
import type { ListProductsQuery } from './products.dto';

export interface PagedProducts {
  data: Product[];
  nextCursor: string | null;
}

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id } });
  }

  /**
   * Keyset pagination. Sort by (sortField, id) so the ordering is fully
   * deterministic; the cursor encodes both values so we can keep
   * walking forward even when many rows share the same effective_price.
   */
  async list(q: ListProductsQuery): Promise<PagedProducts> {
    const sortField = q.sort === 'name' ? 'name' : 'effectivePrice';
    const direction: SortDirection = q.direction;

    const where: Prisma.ProductWhereInput = {};
    if (q.categoryId) where.categoryId = q.categoryId;

    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (decoded) {
        where.AND = [buildKeysetClause(sortField, direction, decoded.sortValue, decoded.id)];
      }
    }

    // Fetch limit+1 so we know whether another page exists.
    const rows = await this.prisma.product.findMany({
      where,
      orderBy: [{ [sortField]: direction }, { id: direction }],
      take: q.limit + 1,
    });

    const hasMore = rows.length > q.limit;
    const data = hasMore ? rows.slice(0, q.limit) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(stringifySortValue(sortField, last), last.id)
        : null;

    return { data, nextCursor };
  }
}

function buildKeysetClause(
  sortField: 'name' | 'effectivePrice',
  direction: SortDirection,
  sortValue: string,
  id: string,
): Prisma.ProductWhereInput {
  const op = direction === 'asc' ? 'gt' : 'lt';
  const sortClause: Prisma.ProductWhereInput =
    sortField === 'name'
      ? { name: { [op]: sortValue } }
      : { effectivePrice: { [op]: new Prisma.Decimal(sortValue) } };

  const tieClause: Prisma.ProductWhereInput =
    sortField === 'name'
      ? { name: sortValue, id: { [op]: id } }
      : { effectivePrice: new Prisma.Decimal(sortValue), id: { [op]: id } };

  return { OR: [sortClause, tieClause] };
}

function stringifySortValue(
  sortField: 'name' | 'effectivePrice',
  product: Product,
): string {
  return sortField === 'name' ? product.name : product.effectivePrice.toString();
}
