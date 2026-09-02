import { z } from 'zod';

const ProviderKeySchema = z.object({
  envVar: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  description: z.string().max(200),
  format: z.object({
    pattern: z.string().optional(),
    prefix: z.string().optional(),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    example: z.string(),
  }),
  signupUrl: z.string().url().optional(),
  docsUrl: z.string().url().optional(),
  rotateUrl: z.string().url().optional(),
  scopesNeeded: z.array(z.string()).optional(),
  verify: z.object({
    method: z.enum(['GET', 'POST']),
    url: z.string().url(),
    headerTemplate: z.record(z.string()),
    expectStatus: z.array(z.number().int()).optional(),
  }).optional(),
})
  .strict()
  .superRefine((key, ctx) => {
    if (!key.verify) {
      return;
    }
    if (!key.verify.url.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verify', 'url'],
        message: 'verify.url must start with https://',
      });
    }
    if (key.verify.url.includes('{{value}}')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verify', 'url'],
        message: 'verify.url must not contain {{value}}',
      });
    }
  });

const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum([
    'llm',
    'database',
    'payments',
    'auth',
    'infra',
    'observability',
    'email',
    'messaging',
    'vcs',
    'other',
  ]),
  keys: z.array(ProviderKeySchema),
}).strict();

export type Provider = z.infer<typeof ProviderSchema>;
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

export { ProviderSchema, ProviderKeySchema };
