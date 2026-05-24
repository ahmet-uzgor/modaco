import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './infra/prisma.module';
import { RedisModule } from './infra/redis.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(buildLoggerOptions(loadEnv())),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
