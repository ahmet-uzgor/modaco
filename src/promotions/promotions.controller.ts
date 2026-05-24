import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
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

  /**
   * Status code depends on scope (plan §9):
   *   - PRODUCT  → 201 Created. Effective price has already been written to
   *                the single target product inside the create transaction.
   *   - CATEGORY → 202 Accepted. The promotion row is committed, but the
   *                materialization across N products runs asynchronously
   *                via JobRunner. Clients poll product detail (or watch
   *                /api/v1/promotions/:id) to observe completion.
   */
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreatePromotionSchema)) body: CreatePromotionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionPresented> {
    const promotion = await this.service.create(body);
    res.status(body.scope === 'CATEGORY' ? 202 : 201);
    return promotion;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', new ParseUUIDPipe()) id: string): Promise<PromotionPresented> {
    return this.service.cancel(id);
  }
}
