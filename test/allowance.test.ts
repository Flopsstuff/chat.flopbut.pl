import { describe, expect, it } from 'vitest';
import { nextDayStart, shareLeft, shareUsed } from '../server/allowance.js';

describe('shareLeft', () => {
  it('rounds up to whole percent, so a sliver still shows', () => {
    expect(shareLeft(0)).toBe(1);
    expect(shareLeft(0.25)).toBe(0.75);
    expect(shareLeft(0.333)).toBe(0.67);
    expect(shareLeft(0.9999)).toBe(0.01);
  });

  it('is zero only once all of it is used', () => {
    expect(shareLeft(1)).toBe(0);
    expect(shareLeft(1.2)).toBe(0);
  });
});

describe('shareUsed', () => {
  const limits = { budgetUsd: 2, contextTokens: 1000 };

  it('is the larger of the budget spent and the context filled', () => {
    expect(shareUsed({ cost: 1, context: 100 }, limits)).toBe(0.5);
    expect(shareUsed({ cost: 0.2, context: 800 }, limits)).toBe(0.8);
    expect(shareUsed(null, limits)).toBe(0);
  });

  it('does not count the gap at the start of every chat', () => {
    const gapped = { ...limits, contextGapTokens: 400 };
    expect(shareUsed({ cost: 0, context: 300 }, gapped)).toBe(0);
    expect(shareUsed({ cost: 0, context: 400 }, gapped)).toBe(0);
    expect(shareUsed({ cost: 0, context: 700 }, gapped)).toBe(0.5);
    expect(shareUsed({ cost: 0, context: 1000 }, gapped)).toBe(1);
    // A gap as large as the limit leaves no room at all.
    const closed = { ...limits, contextGapTokens: 5000 };
    expect(shareUsed({ cost: 0, context: 10 }, closed)).toBe(0);
    expect(shareUsed({ cost: 0, context: 1001 }, closed)).toBe(1);
  });

  it('counts only the context when there is no budget', () => {
    const owner = { budgetUsd: Number.POSITIVE_INFINITY, contextTokens: 1000 };
    expect(shareUsed({ cost: 50, context: 250 }, owner)).toBe(0.25);
  });
});

describe('nextDayStart', () => {
  const at = (iso: string) => nextDayStart(Date.parse(iso));
  const iso = (ts: number) => new Date(ts).toISOString();

  it('is the next midnight in Warsaw', () => {
    // 23:30 on 4 November in Warsaw (UTC+1).
    expect(iso(at('2026-11-04T22:30:00Z'))).toBe('2026-11-04T23:00:00.000Z');
    // 00:30 on 5 November in Warsaw: tomorrow is the 6th.
    expect(iso(at('2026-11-04T23:30:00Z'))).toBe('2026-11-05T23:00:00.000Z');
  });

  it('follows summer time', () => {
    expect(iso(at('2026-07-01T12:00:00Z'))).toBe('2026-07-01T22:00:00.000Z');
    // Clocks go forward on 29 March 2026; that midnight is still UTC+1.
    expect(iso(at('2026-03-28T12:00:00Z'))).toBe('2026-03-28T23:00:00.000Z');
    // Clocks go back on 25 October 2026; the midnight after is UTC+1 again.
    expect(iso(at('2026-10-25T12:00:00Z'))).toBe('2026-10-25T23:00:00.000Z');
    // The midnight that starts 25 October is still summer time.
    expect(iso(at('2026-10-24T12:00:00Z'))).toBe('2026-10-24T22:00:00.000Z');
  });
});
