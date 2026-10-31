import { describe, expect, it } from 'vitest';
import { RateBudget, minimumPollingIntervalMinutes } from '../src/api/rateBudget.js';

const MINUTE = 60_000;

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('minimumPollingIntervalMinutes', () => {
  it('keeps the command reserve free with the default limit', () => {
    // 20 per hour minus 4 reserved leaves 16 polls, i.e. one every 3.75 minutes.
    expect(minimumPollingIntervalMinutes()).toBe(4);
  });

  it('adapts to other limits', () => {
    expect(minimumPollingIntervalMinutes(10, 4)).toBe(10);
    expect(minimumPollingIntervalMinutes(4, 4)).toBe(60);
  });
});

describe('RateBudget', () => {
  it('stops polls at the reserve but still allows commands', () => {
    const c = clock();
    const budget = new RateBudget({ limit: 20, reserve: 4, now: c.now });
    for (let i = 0; i < 16; i++) {
      expect(budget.canSpend('poll')).toBe(true);
      budget.record();
    }
    expect(budget.canSpend('poll')).toBe(false);
    expect(budget.canSpend('command')).toBe(true);
    for (let i = 0; i < 4; i++) {
      budget.record();
    }
    expect(budget.canSpend('command')).toBe(false);
    expect(budget.canSpend('refresh')).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it('never allows more than the limit within one window', () => {
    const c = clock();
    const budget = new RateBudget({ limit: 20, reserve: 0, now: c.now });
    let sent = 0;
    // Try to send a request every 30 seconds for two hours.
    const sentAt: number[] = [];
    for (let t = 0; t < 2 * 60 * MINUTE; t += 30_000) {
      if (budget.canSpend('command')) {
        budget.record();
        sent++;
        sentAt.push(c.now());
      }
      c.advance(30_000);
    }
    expect(sent).toBe(40);
    for (const start of sentAt) {
      const inWindow = sentAt.filter((t) => t >= start && t < start + 60 * MINUTE).length;
      expect(inWindow).toBeLessThanOrEqual(20);
    }
  });

  it('frees slots when they leave the sliding window', () => {
    const c = clock();
    const budget = new RateBudget({ limit: 2, reserve: 0, now: c.now });
    budget.record();
    c.advance(10 * MINUTE);
    budget.record();
    expect(budget.canSpend('command')).toBe(false);
    expect(budget.nextAvailableAt('command')).toBe(c.now() + 50 * MINUTE);
    c.advance(50 * MINUTE);
    expect(budget.canSpend('command')).toBe(true);
  });

  it('computes the next poll slot respecting the reserve', () => {
    const c = clock();
    const budget = new RateBudget({ limit: 3, reserve: 1, now: c.now });
    budget.record();
    c.advance(MINUTE);
    budget.record();
    // Polls need 2 free slots; one is free, the second frees up when the first request expires.
    expect(budget.canSpend('poll')).toBe(false);
    expect(budget.nextAvailableAt('poll')).toBe(c.now() + 59 * MINUTE);
  });

  it('refunds requests that do not count', () => {
    const budget = new RateBudget({ limit: 1, reserve: 0 });
    budget.record();
    expect(budget.remaining()).toBe(0);
    budget.refund();
    expect(budget.remaining()).toBe(1);
  });

  it('trusts stricter server headers until their reset', () => {
    const c = clock();
    const budget = new RateBudget({ limit: 20, reserve: 4, now: c.now });
    budget.record();
    budget.updateFromHeaders({ limit: 20, remaining: 3, resetSeconds: 600 });
    expect(budget.remaining()).toBe(3);
    expect(budget.canSpend('poll')).toBe(false);
    expect(budget.nextAvailableAt('poll')).toBe(c.now() + 600_000);
    budget.record();
    expect(budget.remaining()).toBe(2);
    c.advance(600_000);
    expect(budget.remaining()).toBe(18);
  });

  it('ignores laxer server headers', () => {
    const budget = new RateBudget({ limit: 20, reserve: 0 });
    for (let i = 0; i < 15; i++) {
      budget.record();
    }
    budget.updateFromHeaders({ remaining: 19, resetSeconds: 3600 });
    expect(budget.remaining()).toBe(5);
  });

  it('adopts a changed limit from the headers', () => {
    const budget = new RateBudget({ limit: 20, reserve: 0 });
    budget.updateFromHeaders({ limit: 10 });
    expect(budget.currentLimit).toBe(10);
    expect(budget.remaining()).toBe(10);
  });

  it('blocks everything until Retry-After passed', () => {
    const c = clock();
    const budget = new RateBudget({ now: c.now });
    budget.blockUntil(c.now() + 120_000);
    expect(budget.canSpend('command')).toBe(false);
    expect(budget.nextAvailableAt('command')).toBe(c.now() + 120_000);
    c.advance(120_000);
    expect(budget.canSpend('command')).toBe(true);
  });
});
