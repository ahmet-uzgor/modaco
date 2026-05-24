import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { loadEnv, type Env } from './env';

const ENV_TOKEN = 'ENV';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Zod is the source of truth — Nest's ConfigService just exposes process.env.
      validate: (raw) => loadEnv(raw as NodeJS.ProcessEnv),
    }),
  ],
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => loadEnv(),
    },
  ],
  exports: [ENV_TOKEN],
})
export class ConfigModule {}

export { ENV_TOKEN };
