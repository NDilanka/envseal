import { WORDLIST_LOWER } from './wordlist.js';

export interface ExclusionContext {
  before: string;
  after: string;
}

const WORDLIST_SET = new Set(WORDLIST_LOWER.trim().split('\n'));

export function exclusionReason(
  candidate: string,
  context: ExclusionContext
): string | null {
  if (isNonSecretAssignment(candidate)) return 'env-assignment-short-value';
  if (isGitSha(candidate)) return 'git-sha';
  if (isUUID(candidate)) return 'uuid';
  if (isDigest(candidate, context)) return 'digest';
  if (isDataUri(candidate, context)) return 'data-uri';
  if (isFilesystemPath(candidate)) return 'filesystem-path';
  if (isPlainUrl(candidate)) return 'plain-url';
  if (isHexColour(candidate)) return 'hex-colour';
  if (isIsoTimestamp(candidate)) return 'iso-timestamp';
  if (isSemver(candidate)) return 'semver';
  if (isRepeatedChar(candidate)) return 'repeated-char';
  if (isDictionaryText(candidate)) return 'dictionary-text';
  if (isCodeAdjacent(candidate, context)) return 'code-adjacent';
  if (isNumeric(candidate)) return 'numeric';
  if (isPredictableSequence(candidate)) return 'predictable-sequence';
  if (hasCodeKeyword(candidate)) return 'code-keyword';
  if (isNonLatinProse(candidate)) return 'non-latin-prose';
  return null;
}

export function isExcluded(
  candidate: string,
  context: ExclusionContext
): boolean {
  return exclusionReason(candidate, context) !== null;
}

/**
 * `SCREAMING_SNAKE=value` where the value is too short to be a credential.
 *
 * Text around this product is dense with env-var assignments (`NODE_ENV=production`,
 * `REACT_APP_FEATURE_FLAG_ENABLED=true`), and the whole `KEY=value` token is often
 * long and mixed-case enough to clear the entropy bar on the strength of the key
 * name alone. What matters is the value: anything shorter than the generic-candidate
 * threshold cannot be a credential we would have detected on its own merits, so the
 * assignment as a whole is not evidence of one.
 *
 * This deliberately does NOT suppress `OPENAI_API_KEY=sk-...`: real keys exceed the
 * threshold, and prefixed ones are caught earlier by a high-confidence pattern that
 * never consults the exclusion list.
 */
const MIN_GENERIC_LENGTH = 24;

function isNonSecretAssignment(candidate: string): boolean {
  const match = /^[A-Z][A-Z0-9_]{2,}=(.*)$/.exec(candidate);
  if (match === null) return false;
  const value = match[1];
  if (value === undefined) return false;
  return value.length < MIN_GENERIC_LENGTH;
}

function isGitSha(candidate: string): boolean {
  const len = candidate.length;
  const isLowerHex = /^[0-9a-f]+$/.test(candidate);
  return isLowerHex && (len === 40 || len === 64 || (len >= 7 && len <= 12));
}

function isUUID(candidate: string): boolean {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(candidate);
}

/**
 * Audit fix: these buckets previously excluded on PREFIX alone (`sha256:` +
 * anything), letting attacker-controlled context park a real credential
 * behind an algorithm label or an unvalidated `integrity=` shape. Each now
 * demands a base64/hex body of plausible digest length for its algorithm.
 */
const DIGEST_BODY_FLOOR: Record<string, number> = {
  'sha256:': 43,
  'sha256-': 43,
  'sha512-': 86,
  'sha1-': 27,
  'md5-': 22,
};

function isDigest(candidate: string, context: ExclusionContext): boolean {
  // Standard-base64/hex charset only: SRI and docker-style digest bodies
  // never contain `-` or `_`, but vendor key shapes (sk-proj-*, ghp-*) do.
  // That charset distinction — plus the length floor — is what keeps a real
  // credential from hiding behind an algorithm label.
  const DIGEST_BODY = /^[A-Za-z0-9+/=]+$/;
  for (const [prefix, floor] of Object.entries(DIGEST_BODY_FLOOR)) {
    if (candidate.startsWith(prefix)) {
      const body = candidate.slice(prefix.length);
      return (
        DIGEST_BODY.test(body) && body.length >= floor && body.length <= 88
      );
    }
  }
  if (context.before.endsWith('integrity=') || context.before.endsWith('integrity="')) {
    // SRI values carry their own algorithm prefix; bare base64 in this
    // position is not an SRI hash and gets no exclusion.
    return /^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(candidate);
  }
  return false;
}

function isDataUri(candidate: string, context: ExclusionContext): boolean {
  // Audit fix: was prefix-only. A data: URI must now look like one — a MIME
  // type, and if base64 is claimed, a decodable-length body — before its
  // content can hide from detection.
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(;?[a-z0-9-]+=[a-z0-9-]+)*(;base64,)?(.*)$/i.exec(
    candidate,
  );
  if (match !== null) {
    const [, mime, , base64Marker, body] = match;
    if ((mime ?? '') === '') return false; // `data:` alone proves nothing
    if (base64Marker !== undefined) {
      return /^[A-Za-z0-9+/=]*$/.test(body ?? '') && (body ?? '').length % 4 === 0 && (body ?? '').length > 0;
    }
    return true;
  }
  return /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(;[a-z0-9-]+=[a-z0-9-]+)*;base64,[A-Za-z0-9+/=]+$/.test(
    context.before,
  );
}

function isFilesystemPath(candidate: string): boolean {
  const hasPathSep = candidate.includes('/') || candidate.includes(String.fromCharCode(92));
  if (!hasPathSep) return false;
  const hasCredential = /[a-z][a-z0-9+.-]*:\/\/[^@]*:.*@/.test(candidate);
  if (hasCredential) return false;
  // Audit fix: any slash-containing string used to be excluded, but ~27% of
  // random base64 credentials contain `/`. Require actual path structure:
  // an anchored form or a path-like extension — not merely a slash.
  const pathlike =
    /^\.\.?[/\\]/.test(candidate) || // ./x, ../x
    /^[/\\]/.test(candidate) || // absolute POSIX
    /^[A-Za-z]:[/\\]/.test(candidate) || // drive path
    /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(candidate); // ends in an extension
  return pathlike;
}

function isPlainUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    if (url.username !== '' || url.password !== '') {
      return false;
    }
    // Audit fix: URLs whose query carries credential-shaped parameters are a
    // real delivery channel for keys (Google-style ?key=...), not plain links.
    if (/[?&](key|token|secret|password|passwd|api[-_]?key|access[-_]?token|sig|signature|credential)s?=/i.test(url.search)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isHexColour(candidate: string): boolean {
  return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(candidate) ||
         /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(candidate);
}

function isIsoTimestamp(candidate: string): boolean {
  const isoPattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  return isoPattern.test(candidate);
}

function isSemver(candidate: string): boolean {
  const semverPattern = /^(?:\^|~|>=|<=|>|<)?(?:\d+)(?:\.\d+)?(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
  return semverPattern.test(candidate);
}

function isRepeatedChar(candidate: string): boolean {
  return /^(.)\1+$/.test(candidate);
}

function isDictionaryText(candidate: string): boolean {
  const segments = splitOnBoundaries(candidate);
  const longSegments = segments.map((s) => s.toLowerCase()).filter((s) => s.length >= 3);
  if (longSegments.length < 2) return false;
  const inWordlist = longSegments.filter((s) => WORDLIST_SET.has(s)).length;
  return inWordlist / longSegments.length >= 0.3;
}

function splitOnBoundaries(candidate: string): string[] {
  let result = candidate.split(/[^a-zA-Z]/);
  result = result.flatMap((segment) => {
    if (segment.length === 0) return [];
    const withBoundaries = segment.replace(/([a-z])([A-Z])/g, '$1|$2');
    return withBoundaries.split('|');
  });
  return result.filter((s) => s.length > 0);
}

function isCodeAdjacent(candidate: string, context: ExclusionContext): boolean {
  const codeChars = /[{}();,:]/;
  if (context.before.length > 0) {
    const lastChar = context.before.at(-1);
    if (lastChar !== undefined && codeChars.test(lastChar) && !/\s/.test(lastChar)) return true;
  }
  if (context.after.length > 0) {
    const firstChar = context.after.at(0);
    if (firstChar !== undefined && codeChars.test(firstChar) && !/\s/.test(firstChar)) return true;
  }
  return false;
}


function isNumeric(candidate: string): boolean {
  return /^\d+$/.test(candidate);
}

function isNonLatinProse(candidate: string): boolean {
  let nonAsciiCount = 0;
  let hasAsciiDigit = false;
  for (let i = 0; i < candidate.length; i++) {
    const charCode = candidate.charCodeAt(i);
    if (charCode > 127) nonAsciiCount++;
    if (charCode >= 48 && charCode <= 57) hasAsciiDigit = true;
  }
  const nonAsciiRatio = nonAsciiCount / candidate.length;
  return nonAsciiRatio >= 0.5 && !hasAsciiDigit;
}

function isPredictableSequence(candidate: string): boolean {
  if (/^a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+/.test(candidate)) {
    return true;
  }
  if (/^A+B+C+D+E+F+G+H+I+J+K+L+M+N+O+P+Q+R+S+T+U+V+W+X+Y+Z+/.test(candidate)) {
    return true;
  }
  if (/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(candidate)) {
    return true;
  }
  return false;
}

function hasCodeKeyword(candidate: string): boolean {
  const keywords = [
    'interface', 'type', 'class', 'function', 'const', 'let', 'var',
    'extends', 'implements', 'readonly', 'record', 'string', 'number',
    'boolean', 'async', 'await', 'return', 'import', 'export',
    'docker', 'compose', 'kubernetes', 'kubectl', 'production',
    'development', 'staging', 'environment', 'authentication', 'provider',
    'configuration', 'serialized', 'transaction', 'payload', 'metadata',
  ];
  const lower = candidate.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}
