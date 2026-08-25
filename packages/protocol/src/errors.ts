export const SEP_ERROR_CODES = [
  'SEP_UNKNOWN_KEY',
  'SEP_NOT_DECLARED',
  'SEP_NO_INTERACTIVE_SURFACE',
  'SEP_TICKET_EXPIRED',
  'SEP_TICKET_UNKNOWN',
  'SEP_USER_CANCELLED',
  'SEP_FORMAT_INVALID',
  'SEP_SINK_UNAVAILABLE',
  'SEP_SINK_WRITE_FAILED',
  'SEP_PROBE_NOT_APPROVED',
  'SEP_VALUE_IN_REQUEST',
  'SEP_GITIGNORE_UNSAFE',
  'SEP_CONFIRMATION_DENIED',
  'SEP_RATE_LIMITED',
  'SEP_TARGET_CHANGED',
  'SEP_EGRESS_DENIED',
] as const;

export type SepErrorCode = (typeof SEP_ERROR_CODES)[number];

export interface SepErrorDefaults {
  retriable: boolean;
  userMessage: string;
}

export const SEP_ERROR_DEFAULTS: Record<SepErrorCode, SepErrorDefaults> = {
  SEP_UNKNOWN_KEY: {
    retriable: false,
    userMessage: 'The requested secret key is not known to this project.',
  },
  SEP_NOT_DECLARED: {
    retriable: false,
    userMessage: 'The key was not declared in the manifest. Declare it with env_declare first.',
  },
  SEP_NO_INTERACTIVE_SURFACE: {
    retriable: true,
    userMessage: 'No interactive prompt surface is available (for example, in CI). Configure the missing keys another way.',
  },
  SEP_TICKET_EXPIRED: {
    retriable: true,
    userMessage: 'The request ticket has expired. Open a new request.',
  },
  SEP_TICKET_UNKNOWN: {
    retriable: false,
    userMessage: 'The given ticket is unknown. Open a new request.',
  },
  SEP_USER_CANCELLED: {
    retriable: true,
    userMessage: 'The user cancelled the request.',
  },
  SEP_FORMAT_INVALID: {
    retriable: true,
    userMessage: 'The supplied value does not match the declared format.',
  },
  SEP_SINK_UNAVAILABLE: {
    retriable: false,
    userMessage: 'The configured sink is not available on this system.',
  },
  SEP_SINK_WRITE_FAILED: {
    retriable: true,
    userMessage: 'Failed to write the value to the sink.',
  },
  SEP_PROBE_NOT_APPROVED: {
    retriable: false,
    userMessage: 'The verification probe is not approved. Approve it before verifying.',
  },
  SEP_VALUE_IN_REQUEST: {
    retriable: false,
    userMessage: 'The request contained a value. Declare metadata only; values are entered by the user.',
  },
  SEP_GITIGNORE_UNSAFE: {
    retriable: false,
    userMessage: 'Refusing to write secrets because .gitignore does not protect the sink file.',
  },
  SEP_CONFIRMATION_DENIED: {
    retriable: false,
    userMessage: 'The user denied the confirmation.',
  },
  SEP_RATE_LIMITED: {
    retriable: true,
    userMessage: 'Rate limited. Please retry later.',
  },
  SEP_TARGET_CHANGED: {
    retriable: true,
    userMessage:
      'The program to run changed on disk after you approved it. Nothing was executed. ' +
      'Re-run the command to review the current content and approve it again.',
  },
  SEP_EGRESS_DENIED: {
    retriable: false,
    userMessage:
      'This project uses an egress allowlist, and the command targets a host that is not on it. ' +
      'Nothing was executed or sent. To allow the host, add it to policy.egress.allow in env.schema.jsonc.',
  },
};

export interface SepErrorOptions {
  code: SepErrorCode;
  retriable?: boolean;
  userMessage?: string;
  details?: unknown;
}

export class SepError extends Error {
  readonly code: SepErrorCode;
  readonly retriable: boolean;
  readonly userMessage: string;
  readonly details: unknown;

  constructor(options: SepErrorOptions) {
    const defaults = SEP_ERROR_DEFAULTS[options.code];
    const message = options.userMessage ?? defaults.userMessage;
    super(message);
    this.name = 'SepError';
    this.code = options.code;
    this.retriable = options.retriable ?? defaults.retriable;
    this.userMessage = message;
    this.details = options.details;
  }
}

export function isSepError(value: unknown): value is SepError {
  return value instanceof SepError;
}
