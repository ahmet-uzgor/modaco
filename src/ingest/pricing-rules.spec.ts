import { PricingRuleViolation, applyPricingRules } from './pricing-rules';

describe('applyPricingRules()', () => {
  const base = {
    sku: 'SKU-1',
    name: 'Widget',
    category_name: 'Widgets',
    stock_quantity: 5,
  };

  it('normalises base_price to two decimals with HALF_UP rounding', () => {
    const out = applyPricingRules({ ...base, base_price: '99.995' });
    expect(out.basePrice).toBe('100.00');
  });

  it('passes through when no vendor_cost is given', () => {
    const out = applyPricingRules({ ...base, base_price: '49.50' });
    expect(out.basePrice).toBe('49.50');
  });

  it('keeps base_price when it already satisfies the margin floor', () => {
    const out = applyPricingRules({ ...base, base_price: '15.00', vendor_cost: '10.00' });
    // floor = 10 * 1.10 = 11.00, base 15 > floor → unchanged
    expect(out.basePrice).toBe('15.00');
  });

  it('lifts base_price up to the 10% margin floor when below it', () => {
    const out = applyPricingRules({ ...base, base_price: '10.50', vendor_cost: '10.00' });
    // floor = 11.00, lifted up
    expect(out.basePrice).toBe('11.00');
  });

  it('lifts a vendor "loss leader" (below cost) up to the floor', () => {
    const out = applyPricingRules({ ...base, base_price: '8.00', vendor_cost: '10.00' });
    expect(out.basePrice).toBe('11.00');
  });

  it('rejects negative vendor_cost', () => {
    // The Zod schema parses vendor_cost as a non-negative decimal — but the
    // pricing rule still defends in depth in case a programmer hands it
    // unvalidated data.
    expect(() =>
      applyPricingRules({
        ...base,
        base_price: '10',
        vendor_cost: '-1' as unknown as string,
      }),
    ).toThrow(PricingRuleViolation);
  });
});
