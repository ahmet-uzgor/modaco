import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { Env } from './env';

export function buildLoggerOptions(env: Env): Params {
  const isProd = env.NODE_ENV === 'production';
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: () => ({ service: 'modaco-promotion-api' }),
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                colorize: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,service',
              },
            },
          }),
    },
  };
}
