import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  app.get(Logger).log(`modaco api listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to bootstrap', err);
  process.exit(1);
});
