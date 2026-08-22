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

  // A bare boolean flag used to consume ANY following token as its value, so
  // `envseal status --json OPENAI_API_KEY` parsed --json as the STRING
  // 'OPENAI_API_KEY' (=== true failed) and dropped the key filter entirely:
  // plain-text status for all keys, exit 0. Each command that takes positional
  // arguments is covered in both orders — flags before positionals is what the
  // audit ran into; positionals before flags is what docs/cli-contract.md shows.
  describe('boolean flags do not swallow positionals', () => {
    it('status --json KEY parses json and the key filter in either order', () => {
      const flagFirst = parseArgs(['--json', 'OPENAI_API_KEY']);
      expect(flagFirst.flags.json).toBe(true);
      expect(flagFirst.args).toEqual(['OPENAI_API_KEY']);

      const keyFirst = parseArgs(['OPENAI_API_KEY', '--json']);
      expect(keyFirst.flags.json).toBe(true);
      expect(keyFirst.args).toEqual(['OPENAI_API_KEY']);
    });

    it('verify --json KEY parses json and the key filter in either order', () => {
      const flagFirst = parseArgs(['--json', 'STRIPE_KEY']);
      expect(flagFirst.flags.json).toBe(true);
      expect(flagFirst.args).toEqual(['STRIPE_KEY']);

      const keyFirst = parseArgs(['STRIPE_KEY', '--json']);
      expect(keyFirst.flags.json).toBe(true);
      expect(keyFirst.args).toEqual(['STRIPE_KEY']);
    });

    it('set --json KEY leaves KEY as the positional in either order', () => {
      const flagFirst = parseArgs(['--json', 'MY_KEY']);
      expect(flagFirst.flags.json).toBe(true);
      expect(flagFirst.args).toEqual(['MY_KEY']);

      const keyFirst = parseArgs(['MY_KEY', '--json']);
      expect(keyFirst.flags.json).toBe(true);
      expect(keyFirst.args).toEqual(['MY_KEY']);
    });

    it('run --yes -- cmd keeps the child command intact', () => {
      const parsed = parseArgs(['--yes', '--', 'npm', 'test']);
      expect(parsed.flags.yes).toBe(true);
      expect(parsed.args).toEqual(['--', 'npm', 'test']);
    });
  });

  // The value-taking flags must keep consuming their value wherever it appears,
  // so the fix does not overcorrect into never consuming anything.
  describe('--project consumes its value in both positions', () => {
    it('flag first, then positional', () => {
      const parsed = parseArgs(['--project', '/tmp/p', '--json', 'KEY']);
      expect(parsed.flags.project).toBe('/tmp/p');
      expect(parsed.flags.json).toBe(true);
      expect(parsed.args).toEqual(['KEY']);
    });

    it('positional first, then flag', () => {
      const parsed = parseArgs(['KEY', '--project', '/tmp/p']);
      expect(parsed.flags.project).toBe('/tmp/p');
      expect(parsed.args).toEqual(['KEY']);
    });

    it('init --host still takes its value after another flag', () => {
      const parsed = parseArgs(['--json', '--host', 'cursor']);
      expect(parsed.flags.host).toBe('cursor');
      expect(parsed.flags.json).toBe(true);
    });

    it('a value-taking flag followed by another flag stays boolean-empty', () => {
      // `--project --json`: nothing may be eaten; project gets no value.
      const parsed = parseArgs(['--project', '--json']);
      expect(parsed.flags.project).toBe(true);
      expect(parsed.flags.json).toBe(true);
    });
  });

  // -h used to fall through to the positional loop, so `envseal ensure -h`
  // ran the real command with '-h' as a stray argument (exit 4 under CI).
  describe('-h/--help is a control token, not an argument', () => {
    it('single-dash -h sets flags.help wherever it appears', () => {
      const after = parseArgs(['ensure', '-h']);
      expect(after.flags.help).toBe(true);
      expect(after.args).toEqual(['ensure']);

      const before = parseArgs(['-h', 'ensure']);
      expect(before.flags.help).toBe(true);
      expect(before.args).toEqual(['ensure']);
    });

    it('long --help lands on the same flag', () => {
      // bin.ts strips the command word first; this is the rest of the line.
      const parsed = parseArgs(['MY_KEY', '--help']);
      expect(parsed.flags.help).toBe(true);
      expect(parsed.args).toEqual(['MY_KEY']);
    });

    it('a child --help after -- stays part of the child command', () => {
      // `envseal run -- npm --help` must describe npm, not envseal.
      const parsed = parseArgs(['--yes', '--', 'npm', '--help']);
      expect(parsed.flags.help).toBeUndefined();
      expect(parsed.args).toEqual(['--', 'npm', '--help']);
    });
  });
});
