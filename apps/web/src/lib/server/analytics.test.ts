import { describe, expect, it } from 'vitest';
import { coarseAgent, fnv1a64, optedOut, visitorHash } from './analytics.js';

describe('fnv1a64', () => {
  it('is deterministic', () => {
    expect(fnv1a64('unquote')).toBe(fnv1a64('unquote'));
  });

  it('differs across inputs', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
  });
});

describe('visitorHash', () => {
  const ip = '203.0.113.9';
  const agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15';

  it('is stable within a day', () => {
    const morning = new Date('2026-07-07T08:00:00Z');
    const evening = new Date('2026-07-07T22:00:00Z');
    expect(visitorHash(ip, agent, morning)).toBe(visitorHash(ip, agent, evening));
  });

  it('rotates across days', () => {
    const today = new Date('2026-07-07T12:00:00Z');
    const tomorrow = new Date('2026-07-08T12:00:00Z');
    expect(visitorHash(ip, agent, today)).not.toBe(visitorHash(ip, agent, tomorrow));
  });

  it('separates visitors', () => {
    const now = new Date('2026-07-07T12:00:00Z');
    expect(visitorHash(ip, agent, now)).not.toBe(visitorHash('203.0.113.10', agent, now));
  });

  it('is a decimal UInt64 string', () => {
    expect(visitorHash(ip, agent)).toMatch(/^\d+$/);
  });
});

describe('coarseAgent', () => {
  it('keeps only a short prefix', () => {
    expect(coarseAgent('x'.repeat(100))).toHaveLength(32);
  });
});

describe('optedOut', () => {
  it('honors DNT', () => {
    expect(optedOut(new Headers({ dnt: '1' }))).toBe(true);
  });

  it('honors GPC', () => {
    expect(optedOut(new Headers({ 'sec-gpc': '1' }))).toBe(true);
  });

  it('logs otherwise', () => {
    expect(optedOut(new Headers())).toBe(false);
  });
});
