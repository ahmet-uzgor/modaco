import type { Product } from '@prisma/client';
import { z } from 'zod';
import { formatMoney, money } from '../domain/money';

// ─── Inputs ───────────────────────────────────────────────────────────────────

const decimalString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'expected a decimal with up to 2 fractional digits');

export const CreateProductSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  categoryId: z.string().uuid(),
  basePrice: decimalString,
  stockQuantity: z.number().int().min(0),
});
export type CreateProductDto = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    basePrice: decimalString.optional(),
    stockQuantity: z.number().int().min(0).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.basePrice !== undefined || v.stockQuantity !== undefined,
    { message: 'at least one field must be provided' },
  );
export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;

export const ListProductsQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  sort: z.enum(['effective_price', 'name']).default('effective_price'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

// ─── Output presenter ─────────────────────────────────────────────────────────

export interface ProductPresented {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  basePrice: string;
  stockQuantity: number;
  activePromotionId: string | null;
  effectivePrice: string;
  effectivePriceUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export function presentProduct(p: Product): ProductPresented {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    categoryId: p.categoryId,
    basePrice: formatMoney(money(p.basePrice.toString())),
    stockQuantity: p.stockQuantity,
    activePromotionId: p.activePromotionId,
    effectivePrice: formatMoney(money(p.effectivePrice.toString())),
    effectivePriceUpdatedAt: p.effectivePriceUpdatedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
