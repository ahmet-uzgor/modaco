import { Decimal } from 'decimal.js';
import { maxZero, money, type Money, type MoneyInput, toScale } from './money';

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';

export interface PromotionDiscount {
  discountType: DiscountType;
  discountValue: MoneyInput;
}

export class InvalidEffectivePriceInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEffectivePriceInput';
  }
}

/**
 * Pure function: given a base price and an optional active promotion, return
 * the effective price the customer pays.
 *
 * Plan §6 contract:
 *   - PERCENTAGE: basePrice * (1 - discountValue/100), floored at 0
 *   - FIXED_AMOUNT: basePrice - discountValue, floored at 0
 *   - Rounded to 2 decimals using ROUND_HALF_UP
 *   - Decimal math throughout — never `number`
 */
export function computeEffectivePrice(
  basePrice: MoneyInput,
  promotion: PromotionDiscount | null | undefined,
): Money {
  const base = money(basePrice);
  if (base.isNegative()) {
    throw new InvalidEffectivePriceInput('basePrice must be >= 0');
  }

  if (!promotion) {
    return toScale(base);
  }

  const value = money(promotion.discountValue);
  if (value.lte(0)) {
    throw new InvalidEffectivePriceInput('discountValue must be > 0');
  }

  let raw: Decimal;
  if (promotion.discountType === 'PERCENTAGE') {
    const factor = new Decimal(1).minus(value.div(100));
    raw = base.times(factor);
  } else {
    raw = base.minus(value);
  }

  return toScale(maxZero(raw));
}
