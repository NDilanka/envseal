import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse, PromptKeyResult } from '@envseal/prompters';
import { projectPaths } from '../src/paths.js';
import { Broker } from '../src/broker.js';
import { loadRotationState, recordRotation } from '../src/rotation-state.js';

class StubPrompter implements Prompter {
  readonly id = 'loopback-browser' as const;

  constructor(readonly secretValue: string) {}

  async available(): Promise<boolean> {
    return true;
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const results: PromptKeyResult[] = req.keys.map((key) => ({
      key: key.key,
      outcome: 'entered' as const,
      value: asSecret(Buffer.from(this.secretValue, 'utf8')),
    }));
    return { ticket: req.ticket, results };
  }

  async cancel(): Promise<void> {
    // noop
  }
}

describe('rotation state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-rotation-'));
    writeFileSync(join(tmpDir, '.gitignore'), '.env\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps a record and reloads it', () => {
    const paths = projectPaths(tmpDir);
    const record = recordRotation(paths, 'A_KEY', 'fp_abc', new Date('2026-09-01T00:00:00.000Z'));

    expect(record).toEqual({ fingerprint: 'fp_abc', at: '2026-09-01T00:00:00.000Z' });
    expect(loadRotationState(paths)['A_KEY']).toEqual(record);
  });

  it('re-stamping replaces the record for the key', () => {
    const paths = projectPaths(tmpDir);
    recordRotation(paths, 'A_KEY', 'fp_old', new Date('2026-08-01T00:00:00.000Z'));
    recordRotation(paths, 'A_KEY', 'fp_new', new Date('2026-09-01T00:00:00.000Z'));

    const state = loadRotationState(paths);
    expect(state['A_KEY'].fingerprint).toBe('fp_new');
    expect(state['A_KEY'].at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('describes rotationDue = first sighting + maxAgeDays, stable across reads', async () => {
    const broker = new Broker({ root: tmpDir, prompter: new StubPrompter('sk-rotation-test-value-aaa') });
    await broker.declare({
      entries: [
        {
          key: 'ROTATE_ME',
          description: 'rotation policy test',
          required: true,
          secret: true,
          rotation: { maxAgeDays: 30 },
        },
      ],
    });
    const ticket = await broker.request({ keys: ['ROTATE_ME'], reason: 'test' });
    await broker.await({ ticket: ticket.ticket, timeoutMs: 5000 });

    const before = Date.now();
    const first = await broker.describe();
    const entry = first.entries.find((e) => e.key === 'ROTATE_ME');
    expect(entry?.rotationDue).toBeTruthy();

    const due = Date.parse(entry!.rotationDue!);
    const stamp = due - 30 * 24 * 60 * 60 * 1000;
    expect(stamp).toBeGreaterThanOrEqual(before - 2000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2000);

    const second = await broker.describe();
    expect(second.entries.find((e) => e.key === 'ROTATE_ME')?.rotationDue).toBe(entry!.rotationDue);
    broker.dispose();
  });

  it('re-stamps when the stored value changes', async () => {
    const broker = new Broker({ root: tmpDir, prompter: new StubPrompter('sk-rotation-first-value-000') });
    await broker.declare({
      entries: [
        {
          key: 'ROTATE_ME',
          description: 'rotation policy test',
          required: true,
          secret: true,
          rotation: { maxAgeDays: 30 },
        },
      ],
    });
    const firstTicket = await broker.request({ keys: ['ROTATE_ME'], reason: 'test' });
    await broker.await({ ticket: firstTicket.ticket, timeoutMs: 5000 });
    const firstDue = (await broker.describe()).entries.find((e) => e.key === 'ROTATE_ME')!.rotationDue!;

    broker.dispose();
    const broker2 = new Broker({ root: tmpDir, prompter: new StubPrompter('sk-rotation-second-value-999') });
    const secondTicket = await broker2.request({ keys: ['ROTATE_ME'], reason: 'test' });
    await broker2.await({ ticket: secondTicket.ticket, timeoutMs: 5000 });
    const secondDue = (await broker2.describe()).entries.find((e) => e.key === 'ROTATE_ME')!.rotationDue!;

    expect(Date.parse(secondDue)).toBeGreaterThanOrEqual(Date.parse(firstDue));
    broker2.dispose();
  });

  it('reports null rotationDue without a declared policy', async () => {
    const broker = new Broker({ root: tmpDir, prompter: new StubPrompter('sk-no-policy-value-1234') });
    await broker.declare({
      entries: [{ key: 'NO_POLICY', description: 'no rotation policy', required: true, secret: true }],
    });
    const ticket = await broker.request({ keys: ['NO_POLICY'], reason: 'test' });
    await broker.await({ ticket: ticket.ticket, timeoutMs: 5000 });

    const entry = (await broker.describe()).entries.find((e) => e.key === 'NO_POLICY');
    expect(entry?.present).toBe(true);
    expect(entry?.rotationDue).toBeNull();
    broker.dispose();
  });

  it('records nothing for a declared-but-absent key', async () => {
    const broker = new Broker({ root: tmpDir, prompter: new StubPrompter('sk-unused-1234') });
    await broker.declare({
      entries: [
        { key: 'GHOST', description: 'never provisioned', required: false, secret: true, rotation: { maxAgeDays: 7 } },
      ],
    });
    await broker.describe();

    const paths = projectPaths(tmpDir);
    expect(loadRotationState(paths)['GHOST']).toBeUndefined();
    broker.dispose();
  });

  it('keeps rotation.json out of git by construction (state dir has its own gitignore)', async () => {
    const paths = projectPaths(tmpDir);
    recordRotation(paths, 'A_KEY', 'fp_x');
    expect(existsSync(join(paths.stateDir, '.gitignore'))).toBe(true);
    const gitignore = readFileSync(join(paths.stateDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('*');
  });
});
