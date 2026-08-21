import { describe, it, expect } from 'vitest';
import { EXIT, exitCodeForError, exitCodeForOutcome } from '../src/exit-codes.js';
import { outcomeForKey } from '../src/cli-utils.js';
import { SEP_ERROR_CODES, SepError, TicketKeyOutcome } from '@envseal/protocol';

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

  it('never reports success for a value that is not a SepError', () => {
    // This used to return EXIT.OK. A failure path whose default is "OK" is the
    // exact defect class this suite exists to catch: `fail()` would print an
    // error and exit 0.
    expect(exitCodeForError(new Error('test'))).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForError('string')).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForError(null)).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForError({ code: 'not-a-sep-error' })).toBe(EXIT.UNSATISFIED);
  });
});

describe('exitCodeForOutcome', () => {
  it('maps every ticket outcome to a defined, non-zero-unless-stored code', () => {
    for (const outcome of TicketKeyOutcome.options) {
      const code = exitCodeForOutcome(outcome);
      expect(Object.values(EXIT)).toContain(code);
      // Only a stored key is a success. Every other outcome means the caller
      // did not get what it asked for and must not see 0.
      expect(code === EXIT.OK).toBe(outcome === 'stored');
    }
  });

  it('matches docs/cli-contract.md for each outcome', () => {
    expect(exitCodeForOutcome('stored')).toBe(EXIT.OK);
    expect(exitCodeForOutcome('skipped')).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForOutcome('invalid_format')).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForOutcome('verify_failed')).toBe(EXIT.UNSATISFIED);
    expect(exitCodeForOutcome('cancelled')).toBe(EXIT.CANCELLED);
    expect(exitCodeForOutcome('timeout')).toBe(EXIT.CANCELLED);
  });
});

describe('outcomeForKey', () => {
  it('prefers the recorded per-key outcome', () => {
    expect(
      outcomeForKey(
        { ticket: 't', state: 'resolved', keys: [{ key: 'A', outcome: 'stored' }] },
        'A',
      ),
    ).toBe('stored');
  });

  it('derives an outcome from the ticket state when the prompt recorded none', () => {
    // A ticket that expires or is torn down carries no per-key outcome. `set`
    // used to throw a bare Error here, losing the documented exit code.
    expect(outcomeForKey({ ticket: 't', state: 'expired', keys: [] }, 'A')).toBe('timeout');
    expect(outcomeForKey({ ticket: 't', state: 'pending', keys: [] }, 'A')).toBe('timeout');
    expect(outcomeForKey({ ticket: 't', state: 'cancelled', keys: [] }, 'A')).toBe('cancelled');
  });

  it('reports null only for a resolved ticket that said nothing about the key', () => {
    expect(outcomeForKey({ ticket: 't', state: 'resolved', keys: [] }, 'A')).toBe(null);
  });
});
