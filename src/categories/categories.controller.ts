import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../shared/zod-validation.pipe';
import { CategoriesService } from './categories.service';
import {
  CreateCategorySchema,
  type CategoryPresented,
  type CreateCategoryDto,
} from './categories.dto';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateCategorySchema)) body: CreateCategoryDto,
  ): Promise<CategoryPresented> {
    return this.service.create(body);
  }

  @Get()
  list(): Promise<CategoryPresented[]> {
    return this.service.list();
  }
}
