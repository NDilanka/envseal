/**
 * Shared rendering for the human-consent dialogs across every binding.
 *
 * This used to live twice — hand-maintained twins in @envseal/mcp-server and
 * @envseal/sdk — and a third, weaker copy rolled its own in the CLI's `run`
 * confirmation. One copy here feeds all three: cli, sdk and mcp-server all
 * already depend on @envseal/core, so this adds no dependency edge.
 */

/** Per-argument display cap; longer arguments are shown truncated, and said to be. */
const MAX_ARG_CHARS = 300;

/**
 * Model-supplied argv, key names and probe metadata land in a dialog the user
 * is about to trust. Control characters let a crafted argument forge extra
 * lines — "keys: none", "this command is safe" — inside the very block that
 * exists to tell the truth about the command; Unicode separators can split
 * lines invisibly and bidi controls can reorder what a terminal shows.
 * Render all of them visibly instead.
 */
export function escapeForDisplay(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const c1 =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    out += c1 ? `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return out;
}

export function displayArg(arg: string): string {
  const escaped = escapeForDisplay(arg);
  if (escaped.length <= MAX_ARG_CHARS) {
    return escaped;
  }
  const hidden = escaped.length - MAX_ARG_CHARS;
  return `${escaped.slice(0, MAX_ARG_CHARS)}[... ${hidden} more characters, not shown]`;
}

/**
 * The full `env_use` approval dialog: project, keys, argv one-per-line,
 * content fingerprints of every named file (see exec.ts target hashing),
 * the egress warning or the honest heuristics disclaimer, and the answer
 * format. Every binding renders exactly this.
 */
export function useConfirmationBody(
  info: {
    command: string[];
    keys: string[];
    networkEgress: boolean;
    target?: import('./exec.js').TargetInfo;
  },
  projectRoot: string,
): string {
  const lines: string[] = [
    'EnvSeal is about to run a program with these secrets in its environment.',
    '',
    `  project: ${escapeForDisplay(projectRoot)}`,
    `  keys:    ${info.keys.length > 0 ? info.keys.map(escapeForDisplay).join(', ') : '(none)'}`,
    '',
    '  command, one argument per line, exactly as it will be run (no shell):',
  ];
  info.command.forEach((arg, index) => {
    lines.push(`    [${index}] ${displayArg(arg)}`);
  });
  lines.push('');
  if (info.target) {
    const { resolvedPath, sha256, hashedFiles } = info.target;
    const targetLabel =
      sha256 !== null
        ? escapeForDisplay(resolvedPath)
        : `${escapeForDisplay(resolvedPath)} (not a readable file)`;
    lines.push(`  target:  ${targetLabel}`);
    if (hashedFiles.length > 0) {
      // The approval binds to these fingerprints, not to the text above:
      // every named file is re-hashed just before spawn and any mismatch
      // refuses with SEP_TARGET_CHANGED, so content swapped in after this
      // dialog closes does not run.
      for (const file of hashedFiles) {
        lines.push(`    ${escapeForDisplay(file.argument)}`);
        lines.push(`      sha256: ${file.sha256}`);
      }
      lines.push(
        '  Each listed file is re-checked against its fingerprint immediately',
        '  before the program runs; one that changed since you read this will',
        '  not run.',
      );
    } else {
      // Honest about the boundary of the control: nothing in the command
      // named a readable file, so approval stays name-level.
      lines.push('  No argument named a readable file, so approval covers names only.');
    }
    lines.push('');
  }
  if (info.networkEgress) {
    lines.push(
      '  WARNING: this command can reach the network, so it could send these',
      '           values somewhere. Only continue if you trust it.',
    );
  } else {
    // Honest about what the check is worth: NETWORK_TOOLS plus a URL scan is a
    // heuristic, and claiming more would be the kind of overstatement this
    // project has already had to walk back once.
    lines.push(
      '  No network tool or URL was recognised in this command. That is a',
      '  heuristic, not a guarantee: any program can open a socket.',
    );
  }
  lines.push('', 'Type yes to approve, or submit an empty box to deny. Nothing runs unless you approve.');
  return lines.join('\\n');
}
