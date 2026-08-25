import { describe, it, expect } from 'vitest';
import {
  normalizePayload,
  isDeniedSecretPath,
  decide,
  headOf,
  stripAssignments,
  envIsBare,
  echoReferencesSecret,
  grepIsRecursive,
  grepPattern,
  isSecretShapedPattern,
} from '../hooks/pre-tool-use.js';

describe('pre-tool-use hook', () => {
  describe('isDeniedSecretPath', () => {
    it('denies .env', () => {
      expect(isDeniedSecretPath('.env')).toBe(true);
    });

    it('allows .env.example', () => {
      expect(isDeniedSecretPath('.env.example')).toBe(false);
    });

    it('allows .env.sample', () => {
      expect(isDeniedSecretPath('.env.sample')).toBe(false);
    });

    it('allows .env.template', () => {
      expect(isDeniedSecretPath('.env.template')).toBe(false);
    });

    it('allows env.schema.jsonc', () => {
      expect(isDeniedSecretPath('env.schema.jsonc')).toBe(false);
    });

    it('denies .env.local', () => {
      expect(isDeniedSecretPath('.env.local')).toBe(true);
    });

    it('denies *.pem files', () => {
      expect(isDeniedSecretPath('private.pem')).toBe(true);
    });

    it('denies *.key files', () => {
      expect(isDeniedSecretPath('secret.key')).toBe(true);
    });

    it('denies id_rsa*', () => {
      expect(isDeniedSecretPath('id_rsa')).toBe(true);
      expect(isDeniedSecretPath('id_rsa.pub')).toBe(true);
    });

    it('denies credentials.json', () => {
      expect(isDeniedSecretPath('credentials.json')).toBe(true);
    });

    it('denies secrets.json', () => {
      expect(isDeniedSecretPath('secrets.json')).toBe(true);
    });

    it('denies secrets.yaml', () => {
      expect(isDeniedSecretPath('secrets.yaml')).toBe(true);
    });

    it('denies .envseal/salt', () => {
      expect(isDeniedSecretPath('.envseal/salt')).toBe(true);
    });

    it('denies .envseal/approvals.json', () => {
      expect(isDeniedSecretPath('.envseal/approvals.json')).toBe(true);
    });

    it('allows src/index.ts', () => {
      expect(isDeniedSecretPath('src/index.ts')).toBe(false);
    });

    it('handles backslash paths', () => {
      expect(isDeniedSecretPath('dir\\.env')).toBe(true);
      expect(isDeniedSecretPath('dir\\.env.example')).toBe(false);
    });
  });

  describe('stripAssignments', () => {
    it('strips FOO=bar prefix', () => {
      expect(stripAssignments('FOO=bar echo test')).toBe('echo test');
    });

    it('strips multiple assignments', () => {
      expect(stripAssignments('A=1 B=2 C=3 cmd')).toBe('cmd');
    });

    it('handles quoted assignments (partial support)', () => {
      const result = stripAssignments('FOO="bar baz" echo test');
      // The regex doesn't handle all quote variations, just basic ones
      expect(result.includes('echo')).toBe(true);
    });

    it('returns command if no assignments', () => {
      expect(stripAssignments('echo test')).toBe('echo test');
    });
  });

  describe('headOf', () => {
    it('extracts head from simple command', () => {
      expect(headOf('echo hello')).toBe('echo');
    });

    it('extracts head after stripping assignments', () => {
      expect(headOf('FOO=bar cat file')).toBe('cat');
    });

    it('handles empty string', () => {
      expect(headOf('')).toBe('');
    });
  });

  describe('envIsBare', () => {
    it('detects bare env', () => {
      expect(envIsBare('env')).toBe(true);
    });

    it('allows env with assignments and command', () => {
      expect(envIsBare('env FOO=1 npm test')).toBe(false);
    });

    it('detects env FOO=1 as bare (only assignments)', () => {
      expect(envIsBare('env FOO=1')).toBe(true);
    });

    it('allows env with flags and command', () => {
      expect(envIsBare('env -i npm test')).toBe(false);
    });
  });

  describe('echoReferencesSecret', () => {
    it('detects echo $OPENAI_API_KEY', () => {
      const result = echoReferencesSecret('echo $OPENAI_API_KEY', new Set(['OPENAI_API_KEY']));
      expect(result).toBe('OPENAI_API_KEY');
    });

    it('detects echo ${KEY} format', () => {
      const result = echoReferencesSecret('echo ${DATABASE_URL}', new Set(['DATABASE_URL']));
      expect(result).toBe('DATABASE_URL');
    });

    it('returns null for non-echo command', () => {
      expect(echoReferencesSecret('cat file', new Set(['FOO']))).toBe(null);
    });

    it('returns null for echo with unknown var', () => {
      const result = echoReferencesSecret('echo $UNKNOWN', new Set(['FOO']));
      expect(result).toBe(null);
    });
  });

  describe('grepIsRecursive', () => {
    it('detects grep -r', () => {
      expect(grepIsRecursive('grep -r pattern')).toBe(true);
    });

    it('detects grep --recursive', () => {
      expect(grepIsRecursive('grep --recursive pattern')).toBe(true);
    });

    it('returns false for non-recursive grep', () => {
      expect(grepIsRecursive('grep pattern file')).toBe(false);
    });
  });

  describe('grepPattern', () => {
    it('extracts pattern from grep command (with quotes)', () => {
      // The function returns the token as-is, including quotes
      const pattern = grepPattern('grep -r "sk-" .');
      expect(pattern).toBeDefined();
      expect(pattern?.includes('sk-')).toBe(true);
    });

    it('extracts pattern when no flags', () => {
      const result = grepPattern('grep pattern file');
      expect(result).toBe('pattern');
    });

    it('returns null when no pattern found', () => {
      expect(grepPattern('grep --help')).toBe(null);
    });
  });

  describe('isSecretShapedPattern', () => {
    it('detects KEY pattern', () => {
      expect(isSecretShapedPattern('API_KEY')).toBe(true);
    });

    it('detects TOKEN pattern', () => {
      expect(isSecretShapedPattern('TOKEN')).toBe(true);
    });

    it('detects sk- prefix', () => {
      expect(isSecretShapedPattern('sk-')).toBe(true);
    });

    it('detects ghp_ prefix', () => {
      expect(isSecretShapedPattern('ghp_')).toBe(true);
    });

    it('returns false for ordinary strings', () => {
      expect(isSecretShapedPattern('version')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSecretShapedPattern('')).toBe(false);
    });
  });

  describe('normalizePayload', () => {
    it('extracts tool from tool field', () => {
      const result = normalizePayload({ tool: 'Read', path: '/file' });
      expect(result.tool).toBe('Read');
      expect(result.path).toBe('/file');
    });

    it('extracts tool from tool_name field', () => {
      const result = normalizePayload({ tool_name: 'Edit' });
      expect(result.tool).toBe('Edit');
    });

    it('extracts path from tool_input.file_path', () => {
      const result = normalizePayload({ tool_input: { file_path: '/test' } });
      expect(result.path).toBe('/test');
    });

    it('extracts command', () => {
      const result = normalizePayload({ tool: 'Bash', command: 'ls -la' });
      expect(result.command).toBe('ls -la');
    });

    it('handles undefined payload', () => {
      const result = normalizePayload(undefined);
      expect(result.tool).toBe('');
    });
  });

  describe('decide - file operations', () => {
    it('denies Read .env', () => {
      const decision = decide({ tool: 'Read', path: '.env' });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain('env_describe');
    });

    it('allows Read .env.example', () => {
      const decision = decide({ tool: 'Read', path: '.env.example' });
      expect(decision.allow).toBe(true);
    });

    it('allows Read env.schema.jsonc', () => {
      const decision = decide({ tool: 'Read', path: 'env.schema.jsonc' });
      expect(decision.allow).toBe(true);
    });

    it('allows Read src/index.ts', () => {
      const decision = decide({ tool: 'Read', path: 'src/index.ts' });
      expect(decision.allow).toBe(true);
    });

    it('denies Edit .env', () => {
      const decision = decide({ tool: 'Edit', path: '.env' });
      expect(decision.allow).toBe(false);
    });

    it('denies Write .env', () => {
      const decision = decide({ tool: 'Write', path: '.env' });
      expect(decision.allow).toBe(false);
    });
  });

  describe('decide - bash commands', () => {
    it('denies cat .env', () => {
      const decision = decide({ tool: 'Bash', command: 'cat .env' });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('cat');
    });

    it('denies printenv', () => {
      const decision = decide({ tool: 'Bash', command: 'printenv' });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('printenv');
    });

    it('denies bare env', () => {
      const decision = decide({ tool: 'Bash', command: 'env' });
      expect(decision.allow).toBe(false);
    });

    it('allows env FOO=1 npm test', () => {
      const decision = decide({ tool: 'Bash', command: 'env FOO=1 npm test' });
      expect(decision.allow).toBe(true);
    });

    it('denies echo $OPENAI_API_KEY when declared', () => {
      const decision = decide(
        { tool: 'Bash', command: 'echo $OPENAI_API_KEY' },
        { declaredSecrets: ['OPENAI_API_KEY'] }
      );
      expect(decision.allow).toBe(false);
    });

    it('allows npm test', () => {
      const decision = decide({ tool: 'Bash', command: 'npm test' });
      expect(decision.allow).toBe(true);
    });

    it('denies export -p', () => {
      const decision = decide({ tool: 'Bash', command: 'export -p' });
      expect(decision.allow).toBe(false);
    });

    it('denies grep -r with secret pattern', () => {
      const decision = decide({ tool: 'Bash', command: 'grep -r "sk-" .' });
      expect(decision.allow).toBe(false);
    });
  });

  // W3-07: printf/echo-class env-dump bypasses. `cat .env` inside a command
  // substitution was caught by segment splitting, but `$(<file)` bash
  // shorthand, backtick substitution, and the sed/awk/grep readers had no
  // rule at all — `printf '%s' "$(<.env)"` dumped the file into the
  // transcript while every `cat` shape was blocked.
  describe('decide - printf/echo env-dump bypasses (W3-07)', () => {
    const bypasses: Array<{ label: string; command: string }> = [
      { label: 'printf with cat substitution (already covered)', command: 'printf "%s" "$(cat .env)"' },
      { label: 'printf with $(<file) shorthand', command: 'printf \'%s\' "$(<.env)"' },
      { label: 'echo with $(<file) shorthand', command: 'echo "$(<.env)"' },
      { label: 'echo with spaced $(< file) shorthand', command: 'echo "$(< .env)"' },
      { label: 'printf with sed substitution', command: 'printf \'%s\' "$(sed -n 1p .env)"' },
      { label: 'echo with awk substitution', command: 'echo "$(awk 1 .env)"' },
      { label: 'echo with grep substitution', command: 'echo "$(grep API_KEY .env)"' },
      { label: 'echo with backtick cat substitution', command: 'echo "`cat .env`"' },
      { label: 'printf with backtick sed substitution', command: 'printf \'%s\' "`sed -n 1p .env`"' },
      { label: 'assignment via $(<file) shorthand', command: 'X="$(<.env)"; printf \'%s\' "$X"' },
      { label: 'plain sed read', command: 'sed -n 1p .env' },
      { label: 'plain awk read', command: 'awk 1 .env' },
      { label: 'plain grep read', command: 'grep KEY .env' },
      // rg is the reader agents reach for first; bat and nl are cat-alikes.
      // All three were still absent from FILE_READERS after W3-07 closed
      // sed/awk/grep.
      { label: 'plain rg read', command: 'rg API_KEY .env' },
      { label: 'rg with empty pattern reads the whole file', command: 'rg "" .env' },
      { label: 'echo with rg substitution', command: 'echo "$(rg API_KEY .env)"' },
      { label: 'printf with bat substitution', command: 'printf \'%s\' "$(bat .env)"' },
      { label: 'plain nl read', command: 'nl .env' },
    ];

    for (const bypass of bypasses) {
      it(`denies ${bypass.label}: ${bypass.command}`, () => {
        const decision = decide({ tool: 'Bash', command: bypass.command });
        // Unconditional reason check: a deny without an actionable alternative
        // is a dead end for the model (see denial-messages suite).
        expect(decision.allow, bypass.command).toBe(false);
        expect(decision.reason ?? '').toMatch(/env_describe|env_verify/);
      });
    }

    it('allows benign printf "hello"', () => {
      const decision = decide({ tool: 'Bash', command: 'printf "hello"' });
      expect(decision.allow).toBe(true);
    });

    it('allows benign echo of ordinary text', () => {
      const decision = decide({ tool: 'Bash', command: 'echo "build finished"' });
      expect(decision.allow).toBe(true);
    });

    it('allows printf substitution that reads a non-secret file', () => {
      const decision = decide({ tool: 'Bash', command: 'printf \'%s\' "$(cat src/index.ts)"' });
      expect(decision.allow).toBe(true);
    });

    it('allows sed/awk/grep on ordinary files', () => {
      expect(decide({ tool: 'Bash', command: 'sed -i "s/foo/bar/" package.json' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: "awk '{print $1}' data.txt" }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'grep -rn "TODO" src' }).allow).toBe(true);
    });

    it('allows rg/bat/nl on ordinary files', () => {
      expect(decide({ tool: 'Bash', command: 'rg -n "TODO" src' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'bat README.md' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'nl src/index.ts' }).allow).toBe(true);
    });
  });

  // Audit follow-up: a shell or eval executes a payload STRING whose real
  // head the segment scanner never sees — in `sh -c "cat .env"` the only
  // surface head is `sh`, which matches no reader rule, so the file read
  // sailed through. The payload has to go through the same scanner the
  // outer command went through.
  describe('decide - shell -c / eval payload recursion', () => {
    const payloads: Array<{ label: string; command: string }> = [
      { label: 'sh -c cat .env', command: "sh -c 'cat .env'" },
      { label: 'bash -c head -50 .env', command: 'bash -c "head -50 .env"' },
      { label: 'eval cat .env', command: 'eval "cat .env"' },
    ];

    for (const payload of payloads) {
      it(`denies ${payload.label}`, () => {
        const decision = decide({ tool: 'Bash', command: payload.command });
        // Unconditional reason check: a deny without an actionable alternative
        // is a dead end for the model (see denial-messages suite).
        expect(decision.allow, payload.command).toBe(false);
        expect(decision.reason ?? '').toMatch(/env_describe|env_verify/);
      });
    }

    it('allows benign sh -c echo', () => {
      const decision = decide({ tool: 'Bash', command: "sh -c 'echo hi'" });
      expect(decision.allow).toBe(true);
    });

    it('allows benign sh -c ls of a source dir', () => {
      const decision = decide({ tool: 'Bash', command: "sh -c 'ls src'" });
      expect(decision.allow).toBe(true);
    });
  });

  // Audit follow-up: interpreters execute code STRINGS that open files from
  // inside the language, so no reader head ever appears —
  // `python3 -c "print(open('.env').read())"` has head `python3`, which is
  // not in FILE_READERS. When an interpreter invocation NAMES a denied
  // secret basename anywhere in its arguments, deny.
  describe('decide - interpreter invocations naming secret paths', () => {
    const invocations: Array<{ label: string; command: string }> = [
      { label: 'python3 -c open(.env)', command: "python3 -c \"print(open('.env').read())\"" },
      { label: 'node -p readFileSync(.env)', command: "node -p \"require('fs').readFileSync('.env')\"" },
      { label: 'perl -ne diamond read of .env', command: "perl -ne 'print while <>' .env" },
      { label: 'ruby -e File.read(.env)', command: 'ruby -e "File.read(\'.env\')"' },
    ];

    for (const invocation of invocations) {
      it(`denies ${invocation.label}`, () => {
        const decision = decide({ tool: 'Bash', command: invocation.command });
        // Unconditional reason check: a deny without an actionable alternative
        // is a dead end for the model (see denial-messages suite).
        expect(decision.allow, invocation.command).toBe(false);
        expect(decision.reason ?? '').toMatch(/env_describe|env_verify/);
      });
    }

    it('allows python3 -c print(1)', () => {
      const decision = decide({ tool: 'Bash', command: "python3 -c 'print(1)'" });
      expect(decision.allow).toBe(true);
    });

    it('allows node running an ordinary script', () => {
      const decision = decide({ tool: 'Bash', command: 'node script.js' });
      expect(decision.allow).toBe(true);
    });

    it('allows npm test', () => {
      const decision = decide({ tool: 'Bash', command: 'npm test' });
      expect(decision.allow).toBe(true);
    });
  });

  // Audit follow-up: copiers relocate secret files without ever printing them
  // (the copy gets read somewhere else later), while encoders and printers
  // emit the contents themselves — the same transcript-leak class as `cat`,
  // but none of these heads had a rule. openssl is deliberately NOT in
  // FILE_READERS (it legitimately processes arbitrary binary input), so it is
  // denied only when an argument names a denied secret path.
  describe('decide - copiers, encoders, printers naming secret paths', () => {
    const leaks: Array<{ label: string; command: string }> = [
      { label: 'cp copies .env elsewhere', command: 'cp .env notes.tmp' },
      // dd carries no bare `.env` token — the path hides behind if=/of=.
      { label: 'dd reads .env through if=', command: 'dd if=.env status=none' },
      { label: 'dd overwrites .env through of=', command: 'dd if=/dev/null of=.env' },
      { label: 'ln symlinks .env', command: 'ln -s .env t.txt' },
      { label: 'install copies .env with a mode', command: 'install -m600 .env /tmp/x' },
      { label: 'base64 encodes .env to stdout', command: 'base64 .env' },
      { label: 'openssl base64 reads .env via -in', command: 'openssl base64 -in .env' },
      { label: 'certutil encodes .env', command: 'certutil -encode .env out.b64' },
      { label: 'hexdump dumps .env', command: 'hexdump -C .env' },
      { label: 'sort prints .env ordered', command: 'sort .env' },
      { label: 'tac prints .env reversed', command: 'tac .env' },
      { label: 'rev prints .env flipped', command: 'rev .env' },
      { label: 'fold prints .env wrapped', command: 'fold -w9999 .env' },
      // Literal backslash-n on purpose: paste's CLI delimiter is written \n,
      // and a REAL newline would be torn apart by the segment splitter into a
      // headless fragment no reader rule could match.
      { label: 'paste prints .env joined', command: 'paste -sd\\n .env' },
      { label: 'uniq prints .env filtered', command: 'uniq .env' },
      { label: 'column prints .env tabulated', command: 'column .env' },
      { label: 'jq pretty-prints secrets.json', command: 'jq . secrets.json' },
      { label: 'yq evaluates secrets.yaml', command: 'yq . secrets.yaml' },
      { label: 'diff prints the .env side of a /dev/null comparison', command: 'diff /dev/null .env' },
    ];

    for (const leak of leaks) {
      it(`denies ${leak.label}: ${leak.command}`, () => {
        const decision = decide({ tool: 'Bash', command: leak.command });
        // Unconditional reason check: a deny without an actionable alternative
        // is a dead end for the model (see denial-messages suite).
        expect(decision.allow, leak.command).toBe(false);
        expect(decision.reason ?? '').toMatch(/env_describe|env_verify/);
      });
    }

    it('allows cp of ordinary sources', () => {
      const decision = decide({ tool: 'Bash', command: 'cp src/main.ts backup/' });
      expect(decision.allow).toBe(true);
    });

    it('allows sort/base64/diff on ordinary files', () => {
      expect(decide({ tool: 'Bash', command: 'sort data.txt' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'base64 logo.png' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'diff a.txt b.txt' }).allow).toBe(true);
    });

    it('allows openssl when no argument names a secret path', () => {
      const decision = decide({ tool: 'Bash', command: 'openssl base64 -in plain.txt' });
      expect(decision.allow).toBe(true);
    });

    it('allows benign mv/rsync', () => {
      expect(decide({ tool: 'Bash', command: 'mv notes.txt archive.txt' }).allow).toBe(true);
      expect(decide({ tool: 'Bash', command: 'rsync -av build/ dist/' }).allow).toBe(true);
    });
  });

  describe('denial messages have alternatives', () => {
    const denialCases = [
      { tool: 'Read' as const, path: '.env' },
      { tool: 'Bash' as const, command: 'cat .env' },
      { tool: 'Bash' as const, command: 'printenv' },
      { tool: 'Bash' as const, command: 'env' },
    ];

    for (const testCase of denialCases) {
      it(`${testCase.tool} denial has alternative suggestion`, () => {
        const decision = decide(
          testCase as Parameters<typeof decide>[0],
          { declaredSecrets: ['OPENAI_API_KEY'] }
        );
        // Unconditional: guarding this behind `if (!decision.allow)` would make
        // the test vanish on exactly the regression it exists to catch — a
        // `decide` that started allowing `.env` would pass with zero assertions.
        expect(decision.allow).toBe(false);
        const reason = decision.reason ?? '';
        const hasAlternative =
          reason.includes('env_describe') ||
          reason.includes('env_verify') ||
          reason.includes('env:') ||
          reason.includes('env_request');
        expect(hasAlternative).toBe(true);
      });
    }
  });
});
