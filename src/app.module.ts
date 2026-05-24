import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CacheModule } from './cache/cache.module';
import { CategoriesModule } from './categories/categories.module';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { HealthModule } from './health/health.module';
import { IngestModule } from './ingest/ingest.module';
import { PrismaModule } from './infra/prisma.module';
import { RedisModule } from './infra/redis.module';
import { JobsModule } from './jobs/jobs.module';
import { ProductsModule } from './products/products.module';
import { PromotionsModule } from './promotions/promotions.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(buildLoggerOptions(loadEnv())),
    PrismaModule,
    RedisModule,
    CacheModule,
    JobsModule,
    HealthModule,
    CategoriesModule,
    ProductsModule,
    PromotionsModule,
    IngestModule,
  ],
})
export class AppModule {}
