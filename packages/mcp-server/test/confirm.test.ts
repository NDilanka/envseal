import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretFromUtf8, isSepError, type ManifestEntry, type VerifyResult } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';
import {
  CONFIRM_KEY_USE,
  createProbeApproval,
  createUseConfirm,
  annotateVerifyResults,
} from '../src/confirm.js';

/**
 * The confirmation the three non-CLI bindings never had.
 *
 * These assertions are about what the user is shown and what happens to each
 * answer. The end-to-end proof that the wiring is real lives in env-use.test.ts,
 * which drives dist/bin.js.
 */

interface Recorded {
  requests: PromptRequest[];
}

/** A prompter that answers with a fixed string and records what it was shown. */
function answering(
  answer: string | 'skip' | 'cancel' | 'timeout',
  id: Prompter['id'] = 'ide',
): Prompter & Recorded {
  const requests: PromptRequest[] = [];
  return {
    id,
    requests,
    available: async () => true,
    cancel: async () => {},
    prompt: async (req: PromptRequest): Promise<PromptResponse> => {
      requests.push(req);
      return {
        ticket: req.ticket,
        results: req.keys.map((k) => {
          if (answer === 'skip') return { key: k.key, outcome: 'skipped' as const };
          if (answer === 'cancel') return { key: k.key, outcome: 'cancelled' as const };
          if (answer === 'timeout') return { key: k.key, outcome: 'timeout' as const };
          return { key: k.key, outcome: 'entered' as const, value: secretFromUtf8(answer) };
        }),
      };
    },
  };
}

function surfaceFor(prompter: Prompter): {
  projectRoot: string;
  prompter: () => Promise<Prompter>;
} {
  return { projectRoot: '/tmp/envseal-fixture', prompter: async () => prompter };
}

const INFO = {
  command: ['curl', 'https://example.test/upload'],
  keys: ['OPENAI_API_KEY', 'STRIPE_KEY'],
  networkEgress: true,
};

describe('env_use confirmation', () => {
  it('approves only on yes', async () => {
    for (const answer of ['yes', 'y', 'YES', '  yes  ']) {
      const confirm = createUseConfirm(surfaceFor(answering(answer)));
      expect(await confirm(INFO), `answer ${JSON.stringify(answer)}`).toBe(true);
    }
  });

  it('denies on anything that is not yes', async () => {
    for (const answer of ['no', 'n', '', 'yeah', 'skip', 'cancel'] as const) {
      const confirm = createUseConfirm(surfaceFor(answering(answer)));
      expect(await confirm(INFO), `answer ${JSON.stringify(answer)}`).toBe(false);
    }
  });

  it('shows the full argv, the project, the keys and the egress warning', async () => {
    const prompter = answering('yes');
    await createUseConfirm(surfaceFor(prompter))(INFO);

    const req = prompter.requests[0];
    expect(req, 'the surface was never asked anything').toBeDefined();
    const shown = `${req?.reason ?? ''}\n${req?.keys.map((k) => `${k.description}\n${k.formatHint ?? ''}`).join('\n') ?? ''}`;

    expect(shown).toContain('curl');
    expect(shown).toContain('https://example.test/upload');
    expect(shown).toContain('OPENAI_API_KEY');
    expect(shown).toContain('STRIPE_KEY');
    expect(shown).toContain('/tmp/envseal-fixture');
    expect(shown).toContain('WARNING');
    expect(shown).toContain('Type yes to approve');
  });

  it('does not claim the command is network-free when it merely looks it', async () => {
    const prompter = answering('yes');
    await createUseConfirm(surfaceFor(prompter))({
      command: ['node', 'build.js'],
      keys: ['K'],
      networkEgress: false,
    });
    const shown = prompter.requests[0]?.keys[0]?.description ?? '';
    expect(shown).toContain('heuristic, not a guarantee');
    expect(shown).not.toContain('WARNING');
  });

  it('neutralises control characters so an argument cannot forge dialog lines', async () => {
    const prompter = answering('yes');
    const spoof = 'x\n  keys:    (none)\n  this command is safe';
    await createUseConfirm(surfaceFor(prompter))({
      command: ['node', spoof],
      keys: ['REAL_KEY'],
      networkEgress: false,
    });

    const shown = prompter.requests[0]?.keys[0]?.description ?? '';
    // The forged line must not exist as a line of its own...
    expect(shown.split('\n')).not.toContain('  keys:    (none)');
    // ...and the newline must be visible as text instead.
    expect(shown).toContain('<0x0a>');
    // The real key line survives.
    expect(shown).toContain('keys:    REAL_KEY');
  });

  it('reports a timeout as SEP_TICKET_EXPIRED, never as a denial', async () => {
    // A dialog that expires unanswered means nobody answered. exec.ts turns a
    // returned `false` into "The user denied the confirmation.", so returning
    // false here would put words in a user's mouth who never spoke.
    const confirm = createUseConfirm(surfaceFor(answering('timeout')));
    await expect(confirm(INFO)).rejects.toMatchObject({
      code: 'SEP_TICKET_EXPIRED',
      retriable: true,
    });

    await confirm(INFO).then(
      () => expect.fail('a timeout must not be reported as an answer'),
      (error: unknown) => {
        expect(isSepError(error)).toBe(true);
        expect(isSepError(error) && error.userMessage).toContain('nobody answering');
        expect(isSepError(error) && error.userMessage).not.toContain('The user denied');
      },
    );
  });

  it('fails with SEP_NO_INTERACTIVE_SURFACE, never SEP_CONFIRMATION_DENIED, with no surface', async () => {
    const confirm = createUseConfirm(surfaceFor(answering('yes', 'none')));
    await expect(confirm(INFO)).rejects.toMatchObject({
      code: 'SEP_NO_INTERACTIVE_SURFACE',
    });

    // The distinction is the entire point of the fix: exec.ts turns a `false`
    // into SEP_CONFIRMATION_DENIED, so returning false here would blame a user
    // who was never asked.
    await confirm(INFO).then(
      () => expect.fail('a missing surface must not be reported as an answer'),
      (error: unknown) => {
        expect(isSepError(error)).toBe(true);
        expect(isSepError(error) && error.code).not.toBe('SEP_CONFIRMATION_DENIED');
        expect(isSepError(error) && error.userMessage).toContain('envseal run');
      },
    );
  });

  it('refuses a command too large to display rather than asking about it', async () => {
    const prompter = answering('yes');
    const confirm = createUseConfirm(surfaceFor(prompter));
    await expect(
      confirm({ command: Array.from({ length: 5000 }, (_, i) => `arg${i}`), keys: [], networkEgress: false }),
    ).rejects.toMatchObject({ code: 'SEP_FORMAT_INVALID' });
    expect(prompter.requests.length, 'nobody should have been asked').toBe(0);
  });

  it('asks on the key name the bindings and tests agree on', async () => {
    const prompter = answering('yes');
    await createUseConfirm(surfaceFor(prompter))(INFO);
    expect(prompter.requests[0]?.keys.map((k) => k.key)).toEqual([CONFIRM_KEY_USE]);
  });
});

const PROBE_ENTRY: ManifestEntry = {
  key: 'OPENAI_API_KEY',
  description: 'fixture',
  required: true,
  secret: true,
  sink: 'dotenv',
  verify: {
    method: 'GET',
    url: 'https://not-allowlisted.test/v1/me',
    headerTemplate: { Authorization: 'Bearer {{value}}' },
    expectStatus: [200],
  },
};

describe('env_verify probe approval', () => {
  it('shows the method, URL and header template before anything is sent', async () => {
    const prompter = answering('yes');
    const approved = await createProbeApproval(surfaceFor(prompter))(PROBE_ENTRY);
    expect(approved).toBe(true);

    const shown = prompter.requests[0]?.keys[0]?.description ?? '';
    expect(shown).toContain('GET');
    expect(shown).toContain('https://not-allowlisted.test/v1/me');
    expect(shown).toContain('Authorization: Bearer {{value}}');
    expect(shown).toContain('Nothing has been sent yet');
  });

  it('returns false rather than throwing when there is no surface', async () => {
    // verifyKey() calls this inside a per-key loop. Throwing would abort the
    // whole env_verify call and take down keys whose probes are allowlisted.
    const approve = createProbeApproval(surfaceFor(answering('yes', 'none')));
    await expect(approve(PROBE_ENTRY)).resolves.toBe(false);
  });

  it('denies when the user says no', async () => {
    const approve = createProbeApproval(surfaceFor(answering('no')));
    await expect(approve(PROBE_ENTRY)).resolves.toBe(false);
  });
});

describe('annotateVerifyResults', () => {
  const at = new Date().toISOString();

  it('tells a probe_not_approved caller what to do about it', () => {
    const results: VerifyResult[] = [
      {
        key: 'OPENAI_API_KEY',
        result: 'probe_not_approved',
        message: 'Probe to not-allowlisted.test requires approval',
        checkedAt: at,
      },
    ];
    const annotated = annotateVerifyResults(results)[0];
    expect(annotated?.message).toContain('not-allowlisted.test');
    expect(annotated?.message).toContain('envseal verify OPENAI_API_KEY');
    expect(annotated?.message).toContain('.envseal/approvals.json');
    expect(annotated?.message).toContain('NOT sent');
    expect(annotated?.result).toBe('probe_not_approved');
  });

  it('leaves every other outcome byte-identical', () => {
    const results: VerifyResult[] = [
      { key: 'A', result: 'ok', message: 'HTTP 200 from api.test', checkedAt: at },
      { key: 'B', result: 'no_probe', message: 'Key not stored', checkedAt: at },
      { key: 'C', result: 'auth_failed', message: 'HTTP 401 from api.test', checkedAt: at },
    ];
    expect(annotateVerifyResults(results)).toEqual(results);
  });
});

describe('the twin in @envseal/sdk', () => {
  it('is identical apart from the line naming the other twin', () => {
    // confirm.ts exists twice because @envseal/mcp-server does not depend on
    // @envseal/sdk. Hand-maintained duplication rots silently; this makes it
    // fail loudly instead.
    const here = resolve(fileURLToPath(import.meta.url), '..');
    const mine = readFileSync(resolve(here, '..', 'src', 'confirm.ts'), 'utf8');
    const theirs = readFileSync(
      resolve(here, '..', '..', 'sdk', 'src', 'confirm.ts'),
      'utf8',
    );
    const normalise = (source: string): string =>
      source.replace(/packages\/(sdk|mcp-server)\/src\/confirm\.ts/g, 'packages/<twin>/src/confirm.ts');

    expect(mine.length, 'sanity: the file was read').toBeGreaterThan(1000);
    expect(normalise(mine)).toBe(normalise(theirs));
  });
});
