import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../shared/zod-validation.pipe';
import {
  CreatePromotionSchema,
  ListPromotionsQuerySchema,
  type CreatePromotionDto,
  type ListPromotionsQuery,
  type PromotionPresented,
} from './promotions.dto';
import { PromotionsService } from './promotions.service';

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly service: PromotionsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPromotionsQuerySchema)) query: ListPromotionsQuery,
  ): Promise<PromotionPresented[]> {
    return this.service.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<PromotionPresented> {
    return this.service.getById(id);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreatePromotionSchema)) body: CreatePromotionDto,
  ): Promise<PromotionPresented> {
    return this.service.create(body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', new ParseUUIDPipe()) id: string): Promise<PromotionPresented> {
    return this.service.cancel(id);
  }
}
