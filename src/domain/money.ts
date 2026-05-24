import { Decimal } from 'decimal.js';

// Global Decimal configuration. Money math must be deterministic across the codebase.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;
export type MoneyInput = Decimal.Value;

export const MONEY_SCALE = 2 as const;

export function money(value: MoneyInput): Money {
  return new Decimal(value);
}

export const ZERO: Money = money(0);

export function maxZero(m: Money): Money {
  return Decimal.max(m, ZERO);
}

export function toScale(m: Money): Money {
  return m.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

export function formatMoney(m: Money): string {
  return toScale(m).toFixed(MONEY_SCALE);
}
