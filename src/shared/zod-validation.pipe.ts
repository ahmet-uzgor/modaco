import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodTypeDef } from 'zod';

@Injectable()
export class ZodValidationPipe<Output, Input = Output> implements PipeTransform<Input, Output> {
  constructor(private readonly schema: ZodSchema<Output, ZodTypeDef, Input>) {}

  transform(value: Input): Output {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'ValidationError',
        message: 'Request validation failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
