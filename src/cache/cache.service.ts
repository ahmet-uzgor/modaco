import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';
import { MetricsService } from '../observability/metrics.service';
import { cacheKeys, cacheTtls } from './cache-keys';

const RESOURCE_PRODUCT = 'product';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Resource label is best-effort — we infer it from the key prefix. Keeps
   * counter cardinality bounded to the cache families we actually use.
   */
  private resourceFor(key: string): string {
    if (key.startsWith('product:')) return RESOURCE_PRODUCT;
    return 'other';
  }

  async getJson<T>(key: string): Promise<T | null> {
    const resource = this.resourceFor(key);
    const raw = await this.redis.getClient().get(key);
    if (raw === null) {
      this.metrics.cacheOperations.inc({ operation: 'miss', resource });
      return null;
    }
    try {
      const value = JSON.parse(raw) as T;
      this.metrics.cacheOperations.inc({ operation: 'hit', resource });
      return value;
    } catch (err) {
      // Counted as a miss for downstream-correctness purposes — the caller
      // will read from Postgres next.
      this.metrics.cacheOperations.inc({ operation: 'miss', resource });
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
      this.metrics.cacheOperations.inc(
        { operation: 'invalidate', resource: RESOURCE_PRODUCT },
        productIds.length,
      );
    } catch (err) {
      this.logger.error({ err, count: productIds.length }, 'product cache invalidation failed');
    }
  }
}

export { cacheKeys, cacheTtls };
