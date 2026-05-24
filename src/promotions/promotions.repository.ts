import { Injectable } from '@nestjs/common';
import { Prisma, type Promotion } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import type { ListPromotionsQuery } from './promotions.dto';

@Injectable()
export class PromotionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Promotion | null> {
    return this.prisma.promotion.findUnique({ where: { id } });
  }

  list(q: ListPromotionsQuery): Promise<Promotion[]> {
    const where: Prisma.PromotionWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.scope) where.scope = q.scope;
    if (q.targetProductId) where.targetProductId = q.targetProductId;
    if (q.targetCategoryId) where.targetCategoryId = q.targetCategoryId;

    return this.prisma.promotion.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: q.limit,
    });
  }
}
