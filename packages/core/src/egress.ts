/**
 * Egress target extraction and allowlist matching for env_use.
 *
 * Single source of truth for "can this command reach the network, and where".
 * exec.ts derives its boolean egress heuristic from extraction so the two can
 * never disagree about whether a command is network-touching.
 *
 * The '(unknown)' sentinel marks a network command whose target cannot be
 * determined (bare IPs, encoded hostnames, no target at all). It never
 * matches an allowlist entry — under allowlist mode such a command is
 * refused. That refusal is the feature, not a limitation: an undeterminable
 * destination is exactly what an exfiltration attempt looks like.
 */

export const UNKNOWN_HOST = '(unknown)';

export const NETWORK_TOOLS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'rsync',
  'http',
  'httpie',
  'telnet',
  'socat',
]);

/** Flags whose NEXT argument is a value, not the network target. */
const VALUE_TAKING_FLAGS = new Set([
  '-o',
  '--output',
  '-k',
  '--config',
  '--cookie',
  '-c',
  '--cookie-jar',
  '-H',
  '--header',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '-d',
  '-F',
  '--form',
  '-u',
  '--user',
  '--proxy',
  '-x',
  '--pass',
  '--key',
  '--cacert',
  '--capath',
]);

/** Flags whose value IS a network target specification. */
const TARGET_FLAGS = new Set(['--url', '--connect-to', '--resolve']);

function basenameOf(head: string): string {
  return head.split(/[\\/]/).pop()?.toLowerCase() ?? '';
}

function looksLikeHostname(arg: string): boolean {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(arg)) return false;
  // A dotted quad has no letters — bare IPs stay undetermined by design.
  if (!/[a-z]/i.test(arg) && arg !== 'localhost') return false;
  return arg.includes('.') || arg === 'localhost';
}

/**
 * Extract the network destinations a command could reach.
 *
 * Returns hostnames in lowercase plus UNKNOWN_HOST markers; an empty result
 * means the command cannot reach the network at all. Order is unspecified;
 * callers must treat the set collectively.
 */
export function extractEgressHosts(command: string[]): string[] {
  if (command.length === 0) return [];

  const hosts = new Set<string>();
  const isNetworkTool = NETWORK_TOOLS.has(basenameOf(command[0]!));

  for (let i = 1; i < command.length; i += 1) {
    const arg = command[i]!;
    if (/^https?:\/\//i.test(arg)) {
      try {
        const url = new URL(arg);
        if (url.hostname.length > 0) {
          hosts.add(url.hostname.toLowerCase());
        } else {
          hosts.add(UNKNOWN_HOST);
        }
      } catch {
        // Malformed URL literal still proves network intent.
        hosts.add(UNKNOWN_HOST);
      }
      continue;
    }
    if (isNetworkTool && TARGET_FLAGS.has(arg)) {
      const value = command[i + 1];
      if (value !== undefined) {
        if (/^https?:\/\//i.test(value)) {
          try {
            const url = new URL(value);
            if (url.hostname.length > 0) hosts.add(url.hostname.toLowerCase());
            else hosts.add(UNKNOWN_HOST);
          } catch {
            hosts.add(UNKNOWN_HOST);
          }
        } else if (looksLikeHostname(value)) {
          hosts.add(value.toLowerCase());
        } else {
          hosts.add(UNKNOWN_HOST);
        }
      }
      continue;
    }
  }

  if (isNetworkTool) {
    // Find the positional target: first operand that is neither a flag nor
    // the consumed value of a value-taking flag.
    let skipNext = false;
    let positional: string | undefined;
    for (let i = 1; i < command.length; i += 1) {
      const arg = command[i]!;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (arg.startsWith('-')) {
        if (VALUE_TAKING_FLAGS.has(arg)) skipNext = true;
        continue;
      }
      positional = arg;
      break;
    }

    const hasExplicitTarget =
      positional !== undefined ||
      command.some((a) => /^https?:\/\//i.test(a)) ||
      command.some((a) => TARGET_FLAGS.has(a));

    if (!hasExplicitTarget) {
      hosts.add(UNKNOWN_HOST);
    } else if (positional !== undefined) {
      // A path (/x/y) or :port suffix does not make the host undeterminable —
      // only strip them and judge the host component. Genuinely
      // undeterminable targets (bare IPs, encoded junk) fail the hostname
      // check and land in UNKNOWN_HOST by design.
      const candidate = positional.split('/')[0]!.split(':')[0]!;
      if (looksLikeHostname(candidate)) {
        hosts.add(candidate.toLowerCase());
      } else {
        hosts.add(UNKNOWN_HOST);
      }
    }
  }

  return Array.from(hosts);
}

/**
 * Anchored allowlist matching. '*.suffix' matches exactly one leading label
 * plus '.suffix': api.openai.com yes, openai.com no, a.b.openai.com no,
 * evil.openai.com.attacker.io no. Plain entries are exact (case-insensitive).
 */
export function hostIsAllowed(host: string, allow: string[]): boolean {
  const normalized = host.toLowerCase();
  if (normalized === UNKNOWN_HOST) return false;

  for (const entry of allow) {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) {
      const rest = e.slice(1); // ".openai.com"
      if (normalized.endsWith(rest)) {
        const prefix = normalized.slice(0, normalized.length - rest.length);
        // Exactly one label before the suffix: no dots left of it.
        if (prefix.length > 0 && !prefix.includes('.')) return true;
      }
    } else if (normalized === e) {
      return true;
    }
  }
  return false;
}
