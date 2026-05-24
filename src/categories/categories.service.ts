import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { presentCategory, type CategoryPresented, type CreateCategoryDto } from './categories.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto): Promise<CategoryPresented> {
    try {
      const created = await this.prisma.category.create({ data: { name: dto.name } });
      return presentCategory(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(`Category "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async list(): Promise<CategoryPresented[]> {
    const rows = await this.prisma.category.findMany({ orderBy: { name: 'asc' } });
    return rows.map(presentCategory);
  }
}
