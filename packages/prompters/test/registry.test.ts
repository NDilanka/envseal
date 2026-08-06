import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectPrompter, allPrompters } from '../src/registry.js';
import type { PrompterId } from '../src/types.js';

const ENV_KEYS = ['CI', 'SEP_PREFER_NATIVE'] as const;

function stubAvailability(available: Partial<Record<PrompterId, boolean>>): void {
  const instances = allPrompters();
  for (const prompter of instances) {
    const state = available[prompter.id];
    vi.spyOn(prompter, 'available').mockResolvedValue(state ?? false);
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  vi.restoreAllMocks();
});

describe('allPrompters', () => {
  it('returns the five adapters', () => {
    const ids = allPrompters().map((p) => p.id);
    expect(ids).toHaveLength(5);
    expect(ids).toContain('loopback-browser');
    expect(ids).toContain('native-dialog');
    expect(ids).toContain('ide');
    expect(ids).toContain('tty');
    expect(ids).toContain('none');
  });
});

describe('selectPrompter ordering', () => {
  it('prefers ide when it is available', async () => {
    stubAvailability({ ide: true });
    expect((await selectPrompter()).id).toBe('ide');
  });

  it('skips native unless SEP_PREFER_NATIVE is set, reaching loopback', async () => {
    stubAvailability({ ide: false, 'native-dialog': true, 'loopback-browser': true });
    expect((await selectPrompter()).id).toBe('loopback-browser');
  });

  it('uses native-dialog when SEP_PREFER_NATIVE is set and available', async () => {
    process.env.SEP_PREFER_NATIVE = '1';
    stubAvailability({ ide: false, 'native-dialog': true, 'loopback-browser': true });
    expect((await selectPrompter()).id).toBe('native-dialog');
  });

  it('uses tty only when allowTty is requested', async () => {
    stubAvailability({ ide: false, 'loopback-browser': false, tty: true });
    expect((await selectPrompter({ allowTty: true })).id).toBe('tty');
  });

  it('does not select tty without allowTty', async () => {
    stubAvailability({ ide: false, 'loopback-browser': false, tty: true });
    expect((await selectPrompter()).id).toBe('none');
  });

  it('falls back to none when nothing is available', async () => {
    stubAvailability({});
    expect((await selectPrompter()).id).toBe('none');
  });

  it('prefer overrides CI', async () => {
    process.env.CI = '1';
    stubAvailability({ tty: true });
    expect((await selectPrompter({ prefer: 'tty' })).id).toBe('tty');
  });

  it('prefer throws when the named prompter is unavailable', async () => {
    stubAvailability({ tty: false });
    await expect(selectPrompter({ prefer: 'tty' })).rejects.toThrow();
  });

  it('prefer throws for an unknown id', async () => {
    await expect(
      selectPrompter({ prefer: 'does-not-exist' as PrompterId }),
    ).rejects.toThrow();
  });
});

describe('selectPrompter in CI', () => {
  it('returns none in CI even when other surfaces are available', async () => {
    process.env.CI = '1';
    stubAvailability({ ide: true, 'loopback-browser': true, tty: true });
    expect((await selectPrompter()).id).toBe('none');
  });
});
