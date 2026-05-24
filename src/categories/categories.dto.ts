import { z } from 'zod';

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(255),
});
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

export interface CategoryPresented {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export function presentCategory(c: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): CategoryPresented {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
