import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret, SepError } from '@envseal/protocol';
import { allProviders } from '@envseal/registry';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';
import { projectPaths } from '../src/paths.js';
import { declareEntries } from '../src/manifest.js';
import { readAudit } from '../src/audit.js';
import { Broker } from '../src/broker.js';

/**
 * PLAN §2.2 T3, clause 2: free-text fields that match the secret-shaped
 * detector are rejected, logged, and surfaced. Clause 1 (a literal `value`
 * field) is covered by manifest.test.ts.
 *
 * Every sentinel below is structurally realistic but fake — bodies carry the
 * marker FAKE, the same convention as packages/detector/test/fixtures.
 */

/** High-confidence: a vendor prefix pattern matches it. */
const PREFIXED_SECRET = 'sk-proj-FAKE7Qm2Xp9Lz4Rv8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6Pl9Zx3Cn8Mb';
/**
 * Medium-confidence only: no vendor prefix, so it is reachable ONLY through the
 * generic entropy heuristic. This is the shape of an AWS secret access key, an
 * Azure storage key, or any self-hosted token — a `high`-only threshold writes
 * it straight into env.schema.jsonc.
 */
const UNPREFIXED_SECRET = 'fAkE7Qm2Xp9Lz4Rv8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6Pl9Zx3Cn8Mb5Vq1Kr';
/** High-confidence and shaped like a legal env var name, so it can ride in `key`. */
const AWS_SHAPED_KEY_NAME = 'AKIAFAKE7QM2XP9LZ4RV';

class StubPrompter implements Prompter {
  readonly id = 'loopback-browser' as const;

  async available(): Promise<boolean> {
    return true;
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    return {
      ticket: req.ticket,
      results: req.keys.map((key) => ({
        key: key.key,
        outcome: 'entered' as const,
        value: asSecret(Buffer.from('placeholder-value', 'utf8')),
      })),
    };
  }

  async cancel(): Promise<void> {
    // noop
  }
}

/** Narrow, never cast: a non-SepError must fail the test loudly. */
function asSepError(caught: unknown): SepError {
  if (caught instanceof SepError) return caught;
  throw new Error(`expected a SepError, got: ${String(caught)}`);
}

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}

async function catchAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('secret-shaped input guard', () => {
  let tmpDir: string;
  let paths: ReturnType<typeof projectPaths>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-guard-'));
    writeFileSync(join(tmpDir, '.gitignore'), '.env\n');
    paths = projectPaths(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('env_declare: fields that reach env.schema.jsonc', () => {
    const cases: Array<{ field: string; entry: Record<string, unknown>; secret: string }> = [
      {
        field: 'description',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: `use ${PREFIXED_SECRET}`,
        },
      },
      {
        field: 'description (no vendor prefix, medium confidence)',
        secret: UNPREFIXED_SECRET,
        entry: {
          key: 'APP_SIGNING_SECRET',
          description: `the current value is ${UNPREFIXED_SECRET}`,
        },
      },
      {
        field: 'format.example',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          format: { pattern: '^sk-.+$', example: PREFIXED_SECRET },
        },
      },
      {
        field: 'format.pattern',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          format: { pattern: `^${PREFIXED_SECRET}$` },
        },
      },
      {
        field: 'key',
        secret: AWS_SHAPED_KEY_NAME,
        entry: {
          key: AWS_SHAPED_KEY_NAME,
          description: 'An access key id smuggled in as a variable name',
        },
      },
      {
        field: 'provider.name',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          provider: { id: 'openai', name: `OpenAI ${PREFIXED_SECRET}` },
        },
      },
      {
        field: 'provider.docsUrl',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          provider: {
            id: 'openai',
            name: 'OpenAI',
            docsUrl: `https://example.com/docs?k=${PREFIXED_SECRET}`,
          },
        },
      },
      {
        field: 'provider.scopesNeeded',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          provider: { id: 'openai', name: 'OpenAI', scopesNeeded: ['read', PREFIXED_SECRET] },
        },
      },
      {
        field: 'verify.url',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          verify: {
            method: 'GET',
            url: `https://api.openai.com/v1/models?k=${PREFIXED_SECRET}`,
            headerTemplate: { Authorization: 'Bearer {{value}}' },
          },
        },
      },
      {
        field: 'verify.headerTemplate value',
        secret: PREFIXED_SECRET,
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          verify: {
            method: 'GET',
            url: 'https://api.openai.com/v1/models',
            headerTemplate: { Authorization: `Bearer ${PREFIXED_SECRET}` },
          },
        },
      },
    ];

    for (const { field, entry, secret } of cases) {
      it(`rejects a credential in ${field} without writing the manifest`, async () => {
        const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
        const error = asSepError(await catchAsync(() => broker.declare({ entries: [entry] })));
        broker.dispose();

        expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
        // Names the field, never quotes the matched text.
        expect(error.userMessage).toContain(field.split(' ')[0]);
        expect(error.userMessage).not.toContain(secret);
        expect(JSON.stringify(error.details)).not.toContain(secret);

        expect(existsSync(paths.manifest)).toBe(false);
      });
    }

    it('logs a blocked audit record that does not carry the value', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      await catchAsync(() =>
        broker.declare({
          entries: [{ key: 'OPENAI_API_KEY', description: `use ${PREFIXED_SECRET}` }],
        }),
      );
      broker.dispose();

      const records = readAudit(paths);
      const blocked = records.filter((r) => r.type === 'blocked');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({ type: 'blocked', reason: 'secret_in_declaration' });
      expect(readFileSync(paths.audit, 'utf8')).not.toContain(PREFIXED_SECRET);
    });

    it('leaves an existing manifest untouched when one entry of a batch is rejected', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      await broker.declare({
        entries: [{ key: 'GOOD_KEY', description: 'A perfectly ordinary key' }],
      });
      const before = readFileSync(paths.manifest, 'utf8');

      const error = asSepError(
        await catchAsync(() =>
          broker.declare({
            entries: [
              { key: 'ANOTHER_GOOD_KEY', description: 'Also fine' },
              { key: 'LEAKY_KEY', description: `here it is ${PREFIXED_SECRET}` },
            ],
          }),
        ),
      );
      broker.dispose();

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      const after = readFileSync(paths.manifest, 'utf8');
      expect(after).toBe(before);
      expect(after).not.toContain(PREFIXED_SECRET);
      expect(after).not.toContain('ANOTHER_GOOD_KEY');
    });
  });

  describe('env_declare: legitimate metadata still goes through', () => {
    const accepted: Array<{ label: string; entry: Record<string, unknown> }> = [
      {
        label: 'a description that names the prefix without a value',
        entry: { key: 'OPENAI_API_KEY', description: 'Your OpenAI key, starts with sk-' },
      },
      {
        label: 'a placeholder format.example',
        entry: {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          format: { pattern: '^sk-[A-Za-z0-9]{20,}$', example: 'sk-XXXXXXXXXXXXXXXXXXXX' },
        },
      },
      {
        label: 'a placeholder connection string',
        entry: {
          key: 'DATABASE_URL',
          description: 'Postgres connection string, e.g. postgresql://USERNAME:PASSWORD@localhost:5432/mydb',
        },
      },
      {
        label: 'a realistic long variable name',
        entry: {
          key: 'STRIPE_WEBHOOK_SIGNING_SECRET_V2',
          description: 'Verifies webhook payload signatures',
        },
      },
      {
        label: 'a real docs URL and a {{value}} header template',
        entry: {
          key: 'GITHUB_TOKEN',
          description: 'GitHub personal access token with repo scope',
          provider: {
            id: 'github',
            name: 'GitHub',
            docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure',
          },
          verify: {
            method: 'GET',
            url: 'https://api.github.com/user',
            headerTemplate: { Authorization: 'Bearer {{value}}' },
          },
        },
      },
    ];

    for (const { label, entry } of accepted) {
      it(`accepts ${label}`, async () => {
        const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
        const result = await broker.declare({ entries: [entry] });
        broker.dispose();

        expect(result.added).toEqual([entry.key]);
        expect(readFileSync(paths.manifest, 'utf8')).toContain(String(entry.key));
      });
    }

    // The guard runs on the merged entry, and Broker.declare copies the bundled
    // registry's format/provider/verify onto any entry that omits them. 26 of
    // those bundled strings are placeholder-shaped (`ghp_XXXX…`, `AKIA1111…`),
    // so a guard without a placeholder filter would make every registry-known
    // key undeclarable. This is the test that catches that.
    it('accepts every key in the bundled provider registry', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      const envVars = allProviders().flatMap((p) => p.keys.map((k) => k.envVar));
      expect(envVars.length).toBeGreaterThan(20);

      const rejected: string[] = [];
      for (const envVar of envVars) {
        try {
          await broker.declare({
            entries: [{ key: envVar, description: `Registry-declared ${envVar}` }],
          });
        } catch (error) {
          rejected.push(`${envVar}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      broker.dispose();

      expect(rejected).toEqual([]);
    });
  });

  describe('env_request: reason reaches .envseal/audit.jsonl', () => {
    async function declareTarget(broker: Broker): Promise<void> {
      await broker.declare({
        entries: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API key' }],
      });
    }

    it('rejects a credential in reason before minting a ticket or auditing it', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      await declareTarget(broker);

      const error = asSepError(
        await catchAsync(() =>
          broker.request({ keys: ['OPENAI_API_KEY'], reason: `the key is ${PREFIXED_SECRET}` }),
        ),
      );
      broker.dispose();

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      expect(error.userMessage).toContain('reason');
      expect(error.userMessage).not.toContain(PREFIXED_SECRET);

      const audit = readFileSync(paths.audit, 'utf8');
      expect(audit).not.toContain(PREFIXED_SECRET);
      const records = readAudit(paths);
      expect(records.filter((r) => r.type === 'request')).toEqual([]);
      expect(records.filter((r) => r.type === 'blocked')).toHaveLength(1);
      expect(records.find((r) => r.type === 'blocked')).toMatchObject({
        reason: 'secret_in_request',
      });
    });

    it('rejects an unprefixed high-entropy credential in reason', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      await declareTarget(broker);

      const error = asSepError(
        await catchAsync(() =>
          broker.request({
            keys: ['OPENAI_API_KEY'],
            reason: `store this for me: ${UNPREFIXED_SECRET}`,
          }),
        ),
      );
      broker.dispose();

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      expect(readFileSync(paths.audit, 'utf8')).not.toContain(UNPREFIXED_SECRET);
    });

    it('accepts an ordinary reason and still audits it', async () => {
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      await declareTarget(broker);

      const ticket = await broker.request({
        keys: ['OPENAI_API_KEY'],
        reason: 'Need the key to call the completions endpoint from the test suite',
      });
      broker.dispose();

      expect(ticket.ticket).not.toBe('');
      const requests = readAudit(paths).filter((r) => r.type === 'request');
      expect(requests).toHaveLength(1);
    });
  });

  describe('placeholder padding does not launder a credential', () => {
    it('rejects a real prefix body padded with filler', async () => {
      const padded = `${PREFIXED_SECRET}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
      const broker = new Broker({ root: tmpDir, prompter: new StubPrompter() });
      const error = asSepError(
        await catchAsync(() =>
          broker.declare({
            entries: [
              {
                key: 'OPENAI_API_KEY',
                description: 'OpenAI API key',
                format: { example: padded },
              },
            ],
          }),
        ),
      );
      broker.dispose();

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      expect(existsSync(paths.manifest)).toBe(false);
    });
  });

  describe('the CLI write path is guarded too', () => {
    // packages/cli/src/commands/init.ts calls declareEntries directly rather
    // than going through the Broker, so the guard has to live at this boundary.
    it('declareEntries rejects a credential and writes nothing', () => {
      const error = asSepError(
        catchSync(() =>
          declareEntries(paths, [
            { key: 'SOME_KEY', description: `scanned from source: ${PREFIXED_SECRET}` },
          ]),
        ),
      );

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      expect(existsSync(paths.manifest)).toBe(false);
    });

    it('still rejects an unknown key with SEP_VALUE_IN_REQUEST', () => {
      const error = asSepError(
        catchSync(() =>
          declareEntries(paths, [
            { key: 'SOME_KEY', description: 'fine', value: 'not-allowed-here' },
          ]),
        ),
      );

      expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
      expect(existsSync(paths.manifest)).toBe(false);
    });
  });
});
