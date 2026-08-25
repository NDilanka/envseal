import { isSepError, type SepErrorCode, type TicketKeyOutcome } from '@envseal/protocol';

export const EXIT = {
  OK: 0,
  UNSATISFIED: 1,
  USAGE: 2,
  CANCELLED: 3,
  NO_SURFACE: 4,
  SINK_FAILURE: 5,
  VERIFY_FAILED: 6,
  AUDIT_CHAIN_FAILED: 7,
} as const;

export function exitCodeForError(e: unknown): number {
  if (!isSepError(e)) {
    // Anything that is not a SepError is still a failure. Returning OK here
    // meant a generic thrown Error could exit 0 — a success code on a path that
    // only runs because something went wrong.
    return EXIT.UNSATISFIED;
  }

  const code: SepErrorCode = e.code;

  switch (code) {
    case 'SEP_UNKNOWN_KEY':
    case 'SEP_NOT_DECLARED':
    case 'SEP_GITIGNORE_UNSAFE':
    case 'SEP_PROBE_NOT_APPROVED':
    case 'SEP_VALUE_IN_REQUEST':
      return EXIT.USAGE;

    case 'SEP_NO_INTERACTIVE_SURFACE':
      return EXIT.NO_SURFACE;

    case 'SEP_USER_CANCELLED':
    case 'SEP_TICKET_EXPIRED':
      return EXIT.CANCELLED;

    case 'SEP_SINK_UNAVAILABLE':
    case 'SEP_SINK_WRITE_FAILED':
      return EXIT.SINK_FAILURE;

    case 'SEP_FORMAT_INVALID':
    case 'SEP_RATE_LIMITED':
    case 'SEP_TICKET_UNKNOWN':
    case 'SEP_TARGET_CHANGED':
    case 'SEP_CONFIRMATION_DENIED':
      return EXIT.UNSATISFIED;

    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

/**
 * Exit code for a per-key ticket outcome, per docs/cli-contract.md.
 *
 * `set` and `ensure` previously exited 0 for every outcome including
 * `cancelled`, `invalid_format` and `timeout`, so a shell caller could not tell
 * a stored key from a refused one.
 *
 * `timeout` maps to CANCELLED rather than UNSATISFIED so it agrees with
 * exitCodeForError, which already maps SEP_TICKET_EXPIRED to CANCELLED. The
 * same event reaching a caller by two routes must not produce two codes.
 */
export function exitCodeForOutcome(outcome: TicketKeyOutcome): number {
  switch (outcome) {
    case 'stored':
      return EXIT.OK;

    case 'cancelled':
    case 'timeout':
      return EXIT.CANCELLED;

    case 'skipped':
    case 'invalid_format':
    case 'verify_failed':
      return EXIT.UNSATISFIED;

    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
