import { describe, it, expect } from 'vitest';
import {
  SEP_ERROR_CODES,
  SEP_ERROR_DEFAULTS,
  SepError,
  isSepError,
} from '../src/errors.js';
import type { SepErrorCode } from '../src/errors.js';

describe('SEP_ERROR_DEFAULTS exhaustiveness', () => {
  it('declares a default for every error code', () => {
    expect(SEP_ERROR_CODES.length).toBe(14);
    for (const code of SEP_ERROR_CODES) {
      const defaults = SEP_ERROR_DEFAULTS[code];
      expect(defaults).toBeDefined();
      expect(typeof defaults.retriable).toBe('boolean');
      expect(defaults.userMessage.length).toBeGreaterThan(0);
    }
  });

  it('contains exactly the declared codes and no extras', () => {
    const keys = Object.keys(SEP_ERROR_DEFAULTS) as SepErrorCode[];
    expect(keys.length).toBe(SEP_ERROR_CODES.length);
    for (const key of keys) {
      expect(SEP_ERROR_CODES).toContain(key);
    }
  });

  it('is exhaustively switchable over the union', () => {
    const retriable = (code: SepErrorCode): boolean => {
      switch (code) {
        case 'SEP_UNKNOWN_KEY':
          return false;
        case 'SEP_NOT_DECLARED':
          return false;
        case 'SEP_NO_INTERACTIVE_SURFACE':
          return true;
        case 'SEP_TICKET_EXPIRED':
          return true;
        case 'SEP_TICKET_UNKNOWN':
          return false;
        case 'SEP_USER_CANCELLED':
          return true;
        case 'SEP_FORMAT_INVALID':
          return true;
        case 'SEP_SINK_UNAVAILABLE':
          return false;
        case 'SEP_SINK_WRITE_FAILED':
          return true;
        case 'SEP_PROBE_NOT_APPROVED':
          return false;
        case 'SEP_VALUE_IN_REQUEST':
          return false;
        case 'SEP_GITIGNORE_UNSAFE':
          return false;
        case 'SEP_CONFIRMATION_DENIED':
          return false;
        case 'SEP_RATE_LIMITED':
          return true;
      }
    };
    for (const code of SEP_ERROR_CODES) {
      expect(retriable(code)).toBe(SEP_ERROR_DEFAULTS[code].retriable);
    }
  });
});

describe('SepError', () => {
  it('applies defaults when only a code is given', () => {
    const err = new SepError({ code: 'SEP_RATE_LIMITED' });
    expect(err.code).toBe('SEP_RATE_LIMITED');
    expect(err.retriable).toBe(true);
    expect(err.userMessage).toBe(SEP_ERROR_DEFAULTS.SEP_RATE_LIMITED.userMessage);
    expect(err.name).toBe('SepError');
    expect(err).toBeInstanceOf(Error);
  });

  it('honors explicit overrides and details', () => {
    const details = { key: 'OPENAI_API_KEY', attempt: 3 };
    const err = new SepError({
      code: 'SEP_NOT_DECLARED',
      retriable: true,
      userMessage: 'custom message',
      details,
    });
    expect(err.retriable).toBe(true);
    expect(err.userMessage).toBe('custom message');
    expect(err.details).toBe(details);
    expect(err.message).toBe('custom message');
  });
});

describe('isSepError', () => {
  it('recognizes SepError instances only', () => {
    expect(isSepError(new SepError({ code: 'SEP_UNKNOWN_KEY' }))).toBe(true);
    expect(isSepError(new Error('boom'))).toBe(false);
    expect(isSepError({ code: 'SEP_UNKNOWN_KEY' })).toBe(false);
    expect(isSepError(null)).toBe(false);
    expect(isSepError(undefined)).toBe(false);
    expect(isSepError('SEP_UNKNOWN_KEY')).toBe(false);
  });
});
