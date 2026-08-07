import { SepError, isSepError, type SepErrorCode } from '@envseal/protocol';

export const EXIT = {
  OK: 0,
  UNSATISFIED: 1,
  USAGE: 2,
  CANCELLED: 3,
  NO_SURFACE: 4,
  SINK_FAILURE: 5,
  VERIFY_FAILED: 6,
} as const;

export function exitCodeForError(e: unknown): number {
  if (!isSepError(e)) {
    return EXIT.OK;
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
    case 'SEP_CONFIRMATION_DENIED':
      return EXIT.UNSATISFIED;

    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
