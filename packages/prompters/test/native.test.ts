import { describe, it, expect } from 'vitest';
import { NativePrompter } from '../src/native.js';

describe('native-dialog prompter', () => {
  it('has a stable id', () => {
    expect(new NativePrompter().id).toBe('native-dialog');
  });

  it('prompt with no keys resolves without spawning a dialog', async () => {
    const native = new NativePrompter();
    const result = await native.prompt({
      ticket: 'tkt_test',
      nonce: '7F2A-91C4',
      projectRoot: '/repo',
      reason: 'unit test',
      keys: [],
      timeoutMs: 1000,
    });
    expect(result.ticket).toBe('tkt_test');
    expect(result.results).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('POSIX adapter (osascript/zenity chain)', () => {
    // Cold-starting osascript/zenity on a CI runner can outlast the 5s default.
    it('available() returns a boolean without throwing', { timeout: 30_000 }, async () => {
      const result = await new NativePrompter().available();
      expect(typeof result).toBe('boolean');
    });
  });

  describe.skipIf(process.platform !== 'win32')('Windows adapter (powershell)', () => {
    // A cold powershell.exe spawn takes seconds on a windows runner — the
    // first CI exposure of this test timed out at the 5s default while
    // passing on every dev machine that had a warm powershell.
    it('available() returns a boolean without throwing', { timeout: 30_000 }, async () => {
      const result = await new NativePrompter().available();
      expect(typeof result).toBe('boolean');
    });
  });
});