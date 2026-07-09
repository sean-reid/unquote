import { describe, expect, it } from 'vitest';
import { backoffMs } from '../src/util/http.js';

describe('backoffMs', () => {
  it('uses Retry-After seconds when the server sent them', () => {
    expect(backoffMs('7', 0)).toBe(7000);
  });

  it('falls back to exponential when the header is missing', () => {
    expect(backoffMs(null, 0)).toBe(1000);
    expect(backoffMs(null, 3)).toBe(8000);
  });

  it('never reads a missing or malformed header as a zero wait', () => {
    expect(backoffMs('', 2)).toBe(4000);
    expect(backoffMs('0', 2)).toBe(4000);
    expect(backoffMs('Wed, 21 Oct 2026 07:28:00 GMT', 1)).toBe(2000);
  });
});
