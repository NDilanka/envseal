import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli-utils.js';

/**
 * Regression cover for the end-of-flags terminator.
 *
 * `'--'.startsWith('--')` is true, so a naive flag branch parses the terminator
 * as a flag named '' and consumes the first word of the command after it. That
 * made `envseal run -- <cmd>` fail with "run requires -- followed by command"
 * for every possible invocation — a documented command that could never work.
 */
describe('parseArgs', () => {
  it('treats -- as a terminator, not a flag', () => {
    const parsed = parseArgs(['--project', '/tmp/p', '--json', '--', 'node', '-e', 'x']);
    expect(parsed.flags.project).toBe('/tmp/p');
    expect(parsed.flags.json).toBe(true);
    expect(parsed.args).toEqual(['--', 'node', '-e', 'x']);
    expect(parsed.flags['']).toBeUndefined();
  });

  it('keeps flag-shaped arguments after -- intact', () => {
    // The child command's own flags must not be eaten by the parser.
    const parsed = parseArgs(['--', 'npm', 'test', '--coverage', '--reporter=json']);
    expect(parsed.args).toEqual(['--', 'npm', 'test', '--coverage', '--reporter=json']);
  });

  it('parses --key=value form', () => {
    const parsed = parseArgs(['--project=/tmp/x', 'KEY']);
    expect(parsed.flags.project).toBe('/tmp/x');
    expect(parsed.args).toEqual(['KEY']);
  });

  it('treats a trailing flag with no value as a boolean', () => {
    const parsed = parseArgs(['status', '--json']);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.args).toEqual(['status']);
  });
});
