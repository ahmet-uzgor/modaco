import type { Promotion } from '@prisma/client';
import { z } from 'zod';
import { formatMoney, money } from '../domain/money';

const decimalString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'expected a decimal with up to 2 fractional digits');

const isoDate = z.coerce.date();

export const CreatePromotionSchema = z
  .object({
    name: z.string().min(1).max(255),
    discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
    discountValue: decimalString,
    scope: z.enum(['PRODUCT', 'CATEGORY']),
    targetProductId: z.string().uuid().optional(),
    targetCategoryId: z.string().uuid().optional(),
    startsAt: isoDate,
    endsAt: isoDate,
  })
  .refine((v) => v.endsAt.getTime() > v.startsAt.getTime(), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .refine(
    (v) =>
      v.scope === 'PRODUCT'
        ? v.targetProductId !== undefined && v.targetCategoryId === undefined
        : v.targetCategoryId !== undefined && v.targetProductId === undefined,
    {
      message:
        'For scope=PRODUCT set targetProductId; for scope=CATEGORY set targetCategoryId. Set exactly one.',
      path: ['scope'],
    },
  );
export type CreatePromotionDto = z.infer<typeof CreatePromotionSchema>;

export const ListPromotionsQuerySchema = z.object({
  status: z.enum(['SCHEDULED', 'ACTIVE', 'CANCELLED', 'EXPIRED']).optional(),
  scope: z.enum(['PRODUCT', 'CATEGORY']).optional(),
  targetProductId: z.string().uuid().optional(),
  targetCategoryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPromotionsQuery = z.infer<typeof ListPromotionsQuerySchema>;

export interface PromotionPresented {
  id: string;
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: string;
  scope: 'PRODUCT' | 'CATEGORY';
  targetProductId: string | null;
  targetCategoryId: string | null;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
  updatedAt: string;
}

export function presentPromotion(p: Promotion): PromotionPresented {
  return {
    id: p.id,
    name: p.name,
    discountType: p.discountType,
    discountValue: formatMoney(money(p.discountValue.toString())),
    scope: p.scope,
    targetProductId: p.targetProductId,
    targetCategoryId: p.targetCategoryId,
    startsAt: p.startsAt.toISOString(),
    endsAt: p.endsAt.toISOString(),
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
