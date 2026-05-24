import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../shared/zod-validation.pipe';
import type { PageResult } from '../shared/pagination';
import { ProductsService } from './products.service';
import {
  CreateProductSchema,
  ListProductsQuerySchema,
  UpdateProductSchema,
  type CreateProductDto,
  type ListProductsQuery,
  type ProductPresented,
  type UpdateProductDto,
} from './products.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListProductsQuerySchema)) query: ListProductsQuery,
  ): Promise<PageResult<ProductPresented>> {
    return this.service.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<ProductPresented> {
    return this.service.getById(id);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateProductSchema)) body: CreateProductDto,
  ): Promise<ProductPresented> {
    return this.service.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateProductSchema)) body: UpdateProductDto,
  ): Promise<ProductPresented> {
    return this.service.update(id, body);
  }
}
