import { computeEffectivePrice, InvalidEffectivePriceInput } from './effective-price';

describe('computeEffectivePrice() — no promotion', () => {
  it('returns base price scaled to 2 decimals', () => {
    expect(computeEffectivePrice('100', null).toString()).toBe('100');
    expect(computeEffectivePrice('99.999', null).toString()).toBe('100');
    expect(computeEffectivePrice('99.994', null).toString()).toBe('99.99');
  });

  it('treats undefined the same as null', () => {
    expect(computeEffectivePrice('50', undefined).toString()).toBe('50');
  });

  it('rejects negative base price', () => {
    expect(() => computeEffectivePrice('-1', null)).toThrow(InvalidEffectivePriceInput);
  });
});

describe('computeEffectivePrice() — PERCENTAGE', () => {
  it.each([
    ['100', '25', '75'],
    ['100', '0.5', '99.5'],
    ['200', '50', '100'],
    ['19.99', '10', '17.99'],
  ])('%s with %s%% off -> %s', (base, pct, expected) => {
    expect(
      computeEffectivePrice(base, { discountType: 'PERCENTAGE', discountValue: pct }).toString(),
    ).toBe(expected);
  });

  it('clamps at zero when discount >= 100%', () => {
    expect(
      computeEffectivePrice('100', {
        discountType: 'PERCENTAGE',
        discountValue: '100',
      }).toString(),
    ).toBe('0');

    expect(
      computeEffectivePrice('100', {
        discountType: 'PERCENTAGE',
        discountValue: '150',
      }).toString(),
    ).toBe('0');
  });

  it('rounds HALF_UP at 2 decimal places', () => {
    // 100 * (1 - 33.335/100) = 100 * 0.66665 = 66.665 -> 66.67 (HALF_UP)
    expect(
      computeEffectivePrice('100', {
        discountType: 'PERCENTAGE',
        discountValue: '33.335',
      }).toString(),
    ).toBe('66.67');

    // 100 * (1 - 33.334/100) = 66.666 -> 66.67
    expect(
      computeEffectivePrice('100', {
        discountType: 'PERCENTAGE',
        discountValue: '33.334',
      }).toString(),
    ).toBe('66.67');
  });

  it('does not drift on cheap base prices', () => {
    // 1.99 with 10% off = 1.791 -> 1.79
    expect(
      computeEffectivePrice('1.99', {
        discountType: 'PERCENTAGE',
        discountValue: '10',
      }).toString(),
    ).toBe('1.79');
  });
});

describe('computeEffectivePrice() — FIXED_AMOUNT', () => {
  it.each([
    ['100', '10', '90'],
    ['100', '99.99', '0.01'],
    ['100', '100', '0'],
    ['100', '150', '0'], // floor at zero
  ])('%s minus $%s -> %s', (base, off, expected) => {
    expect(
      computeEffectivePrice(base, {
        discountType: 'FIXED_AMOUNT',
        discountValue: off,
      }).toString(),
    ).toBe(expected);
  });
});

describe('computeEffectivePrice() — invalid discount value', () => {
  it.each([
    ['0', 'PERCENTAGE'],
    ['-1', 'PERCENTAGE'],
    ['0', 'FIXED_AMOUNT'],
    ['-5', 'FIXED_AMOUNT'],
  ] as const)('rejects discountValue=%s (%s)', (value, type) => {
    expect(() =>
      computeEffectivePrice('100', { discountType: type, discountValue: value }),
    ).toThrow(InvalidEffectivePriceInput);
  });
});
