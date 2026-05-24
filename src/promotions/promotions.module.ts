import { Module } from '@nestjs/common';
import { MaterializationService } from './materialization.service';
import { PromotionsController } from './promotions.controller';
import { PromotionsRepository } from './promotions.repository';
import { PromotionsService } from './promotions.service';

@Module({
  controllers: [PromotionsController],
  providers: [PromotionsService, PromotionsRepository, MaterializationService],
  exports: [PromotionsService, PromotionsRepository, MaterializationService],
})
export class PromotionsModule {}
