import { Decimal } from 'decimal.js';
import { ZERO, formatMoney, maxZero, money, toScale } from './money';

describe('money()', () => {
  it('accepts string, number, and Decimal', () => {
    expect(money('1.23').toString()).toBe('1.23');
    expect(money(1.23).toString()).toBe('1.23');
    expect(money(new Decimal('1.23')).toString()).toBe('1.23');
  });

  it('preserves precision better than IEEE float', () => {
    // The classic 0.1 + 0.2 floating-point trap.
    expect(money('0.1').plus(money('0.2')).toString()).toBe('0.3');
  });
});

describe('maxZero()', () => {
  it('clamps negative values to zero', () => {
    expect(maxZero(money('-5')).toString()).toBe('0');
  });

  it('passes positive values through', () => {
    expect(maxZero(money('5')).toString()).toBe('5');
  });

  it('passes zero through', () => {
    expect(maxZero(ZERO).toString()).toBe('0');
  });
});

describe('toScale() — ROUND_HALF_UP at 2 decimals', () => {
  // ROUND_HALF_UP rounds .5 away from zero.
  // toScale() rounds the value but Decimal#toString trims trailing zeros,
  // so we compare the *numeric* result rather than the formatted string —
  // formatMoney() is the one that pads to two decimals.
  it.each([
    ['1.005', '1.01'],
    ['1.004', '1'],
    ['1.015', '1.02'],
    ['2.554', '2.55'],
    ['2.555', '2.56'],
    ['0', '0'],
    ['100', '100'],
  ])('toScale(%s) -> %s', (input, expected) => {
    expect(toScale(money(input)).toString()).toBe(expected);
  });
});

describe('formatMoney()', () => {
  it('always emits two decimal places', () => {
    expect(formatMoney(money('1'))).toBe('1.00');
    expect(formatMoney(money('1.5'))).toBe('1.50');
    expect(formatMoney(money('1.005'))).toBe('1.01');
    expect(formatMoney(money('0'))).toBe('0.00');
  });
});
