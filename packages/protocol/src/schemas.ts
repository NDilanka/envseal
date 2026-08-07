import { z } from 'zod';

export const ManifestEntry = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    description: z.string().max(280),
    required: z.boolean().default(true),
    secret: z.boolean().default(true),
    format: z
      .object({
        pattern: z.string().optional(),
        minLength: z.number().int().optional(),
        maxLength: z.number().int().optional(),
        example: z.string().optional(),
      })
      .optional(),
    provider: z
      .object({
        id: z.string(),
        name: z.string(),
        signupUrl: z.string().url().optional(),
        docsUrl: z.string().url().optional(),
        rotateUrl: z.string().url().optional(),
        scopesNeeded: z.array(z.string()).optional(),
      })
      .optional(),
    verify: z
      .object({
        method: z.enum(['GET', 'POST']),
        url: z.string().url(),
        headerTemplate: z.record(z.string()),
        expectStatus: z.array(z.number().int()).default([200]),
      })
      .optional(),
    sink: z
      .enum(['dotenv', 'keychain', 'sops', 'onepassword', 'doppler', 'vault', 'external'])
      .default('dotenv'),
    rotation: z.object({ maxAgeDays: z.number().int() }).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!entry.verify) {
      return;
    }
    if (!entry.verify.url.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verify', 'url'],
        message: 'verify.url must start with https://',
      });
    }
    if (entry.verify.url.includes('{{value}}')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verify', 'url'],
        message: 'verify.url must not contain {{value}}',
      });
    }
  });

export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    entries: z.array(ManifestEntry).default([]),
  })
  .strict();

export type Manifest = z.infer<typeof Manifest>;

export const KeyStatus = z
  .object({
    key: z.string(),
    declared: z.boolean(),
    present: z.boolean(),
    sink: z.string(),
    // Nullable because "we have not validated THIS value" is a real state and
  // must not be reported as true. env_describe deliberately does not
  // re-evaluate a model-supplied format.pattern against a stored secret —
  // doing so is a chosen-predicate oracle over the value.
  formatValid: z.boolean().nullable(),
    lengthBucket: z.string(),
    fingerprint: z.string(),
    lastVerified: z.string().nullable(),
    verifyResult: z
      .enum(['ok', 'auth_failed', 'forbidden', 'rate_limited', 'network_error', 'no_probe', 'probe_not_approved'])
      .nullable(),
    source: z.enum(['user-prompt', 'preexisting', 'ci', 'imported']),
    rotationDue: z.string().nullable(),
  })
  .strict();

export type KeyStatus = z.infer<typeof KeyStatus>;

export const Ticket = z
  .object({
    ticket: z.string(),
    nonce: z.string(),
    surface: z.enum(['loopback-browser', 'native-dialog', 'ide', 'tty', 'none']),
    expiresAt: z.string(),
    userMessage: z.string(),
  })
  .strict();

export type Ticket = z.infer<typeof Ticket>;

export const TicketKeyOutcome = z.enum([
  'stored',
  'skipped',
  'cancelled',
  'invalid_format',
  'verify_failed',
  'timeout',
]);

export type TicketKeyOutcome = z.infer<typeof TicketKeyOutcome>;

export const TicketOutcome = z
  .object({
    ticket: z.string(),
    state: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
    keys: z
      .array(
        z
          .object({
            key: z.string(),
            outcome: TicketKeyOutcome,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type TicketOutcome = z.infer<typeof TicketOutcome>;

export const VerifyResult = z
  .object({
    key: z.string(),
    result: z.enum(['ok', 'auth_failed', 'forbidden', 'rate_limited', 'network_error', 'no_probe', 'probe_not_approved']),
    message: z.string(),
    checkedAt: z.string(),
  })
  .strict();

export type VerifyResult = z.infer<typeof VerifyResult>;

export const ExecResult = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    redactedCount: z.number().int(),
  })
  .strict();

export type ExecResult = z.infer<typeof ExecResult>;

export const DeclareResult = z
  .object({
    added: z.array(z.string()).default([]),
    updated: z.array(z.string()).default([]),
    unchanged: z.array(z.string()).default([]),
  })
  .strict();

export type DeclareResult = z.infer<typeof DeclareResult>;

export const RevokeResult = z
  .object({
    key: z.string(),
    removed: z.boolean(),
    rotateUrl: z.string().nullable(),
  })
  .strict();

export type RevokeResult = z.infer<typeof RevokeResult>;

export const RevokeResults = z.array(RevokeResult);

export type RevokeResults = z.infer<typeof RevokeResults>;

export const ManifestStatus = z
  .object({
    projectRoot: z.string(),
    manifestPath: z.string().nullable(),
    entries: z.array(KeyStatus),
    missingRequired: z.array(z.string()).default([]),
  })
  .strict();

export type ManifestStatus = z.infer<typeof ManifestStatus>;

export const EnvDescribeInput = z
  .object({
    scope: z.string().optional(),
  })
  .strict();

export type EnvDescribeInput = z.infer<typeof EnvDescribeInput>;

export const EnvDeclareInput = z
  .object({
    entries: z.array(ManifestEntry).min(1),
  })
  .strict();

export type EnvDeclareInput = z.infer<typeof EnvDeclareInput>;

export const EnvRequestInput = z
  .object({
    keys: z.array(z.string()).min(1),
    reason: z.string().min(1).max(280),
  })
  .strict();

export type EnvRequestInput = z.infer<typeof EnvRequestInput>;

export const EnvAwaitInput = z
  .object({
    ticket: z.string(),
    timeoutMs: z.number().int().min(1000).max(120000).default(90000),
  })
  .strict();

export type EnvAwaitInput = z.infer<typeof EnvAwaitInput>;

export const EnvVerifyInput = z
  .object({
    keys: z.array(z.string()).min(1),
  })
  .strict();

export type EnvVerifyInput = z.infer<typeof EnvVerifyInput>;

export const EnvUseInput = z
  .object({
    keys: z.array(z.string()).min(1),
    command: z.array(z.string()).min(1),
  })
  .strict();

export type EnvUseInput = z.infer<typeof EnvUseInput>;

export const EnvRevokeInput = z
  .object({
    keys: z.array(z.string()).min(1),
  })
  .strict();

export type EnvRevokeInput = z.infer<typeof EnvRevokeInput>;

export const INPUT_SCHEMAS = {
  env_describe: EnvDescribeInput,
  env_declare: EnvDeclareInput,
  env_request: EnvRequestInput,
  env_await: EnvAwaitInput,
  env_verify: EnvVerifyInput,
  env_use: EnvUseInput,
  env_revoke: EnvRevokeInput,
} as const;
