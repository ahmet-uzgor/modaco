import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';
import { cacheKeys, cacheTtls } from './cache-keys';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.getClient().get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn({ key, err }, 'cache value was not valid JSON; treating as miss');
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSec: number): Promise<void> {
    await this.redis.getClient().set(key, JSON.stringify(value), 'EX', ttlSec);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length === 1) {
      await this.redis.getClient().del(keys[0]!);
      return;
    }
    const pipe = this.redis.getClient().pipeline();
    for (const k of keys) pipe.del(k);
    await pipe.exec();
  }

  /**
   * Invalidate the product detail cache for one or more products. Used after
   * any write that affects effective_price. Failures are logged loudly but
   * never thrown — TTL is the safety net (plan §10).
   */
  async invalidateProducts(productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return;
    try {
      await this.del(...productIds.map(cacheKeys.product));
    } catch (err) {
      this.logger.error({ err, count: productIds.length }, 'product cache invalidation failed');
    }
  }
}

export { cacheKeys, cacheTtls };
