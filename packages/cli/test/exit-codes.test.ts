import { describe, it, expect } from 'vitest';
import { EXIT, exitCodeForError } from '../src/exit-codes.js';
import { SEP_ERROR_CODES, SepError } from '@envseal/protocol';

describe('exit codes', () => {
  it('defines all required exit codes', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.UNSATISFIED).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.CANCELLED).toBe(3);
    expect(EXIT.NO_SURFACE).toBe(4);
    expect(EXIT.SINK_FAILURE).toBe(5);
    expect(EXIT.VERIFY_FAILED).toBe(6);
  });

  it('maps all SepError codes to defined exit codes', () => {
    for (const code of SEP_ERROR_CODES) {
      const error = new SepError({ code });
      const exitCode = exitCodeForError(error);
      expect(typeof exitCode).toBe('number');
      expect(Object.values(EXIT)).toContain(exitCode);
    }
  });

  it('returns OK for non-SepError', () => {
    expect(exitCodeForError(new Error('test'))).toBe(EXIT.OK);
    expect(exitCodeForError('string')).toBe(EXIT.OK);
    expect(exitCodeForError(null)).toBe(EXIT.OK);
  });
});
