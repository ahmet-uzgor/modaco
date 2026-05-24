import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, Observable, tap, throwError } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Records http_request_duration_seconds for every matched route.
 *
 * Uses Express's req.route.path so labels carry the route TEMPLATE
 * ("/products/:id") rather than the actual URL with a uuid in it —
 * that keeps the metric cardinality bounded.
 *
 * /metrics, /health and /ready are intentionally excluded so the
 * histogram isn't dominated by Prometheus scrapes and k8s probes.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private static readonly IGNORED = new Set(['/metrics', '/health', '/ready']);

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (HttpMetricsInterceptor.IGNORED.has(req.path)) {
      return next.handle();
    }

    const route = req.route?.path ?? 'unmatched';
    const method = req.method;
    const stopTimer = this.metrics.httpRequestDuration.startTimer({ method, route });

    return next.handle().pipe(
      tap(() => {
        const res = http.getResponse<Response>();
        stopTimer({ status_code: String(res.statusCode) });
      }),
      catchError((err: unknown) => {
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status: unknown }).status) || 500
            : 500;
        stopTimer({ status_code: String(status) });
        return throwError(() => err);
      }),
    );
  }
}
