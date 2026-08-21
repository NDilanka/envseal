import { detect } from '@envseal/detector';
import type { Detection } from '@envseal/detector';
import { SepError } from '@envseal/protocol';
import type { ManifestEntry } from '@envseal/protocol';

/**
 * Secret-shaped-input guard for the model-facing free-text boundary (PLAN §2.2 T3).
 *
 * `.strict()` on the protocol schemas rejects a literal `value` field, which is
 * the only leak an honest caller commits by accident. It does nothing about the
 * fields that are SUPPOSED to hold prose: a credential pasted into an
 * `env_declare` description or a `format.example` was written verbatim into
 * `env.schema.jsonc` — a file §6.1 commits to git — and one pasted into an
 * `env_request` reason was written verbatim into `.envseal/audit.jsonl`, which
 * §4.1 says holds "names only, no values". `@envseal/detector` existed for
 * exactly this and had no consumer inside the broker.
 *
 * Nothing here ever echoes the matched text. A finding carries the field path
 * and the detector's pattern label, both of which are safe to put in an error
 * message and in the audit log; the value itself never leaves this module.
 */

/**
 * Which detector confidences reject.
 *
 * `high` alone is not enough. Measured over 17 structurally realistic
 * credentials with random bodies, a high-only threshold let three through —
 * `wJalrXUtnFEMI7K2MDENGbPxRfiCYT7qLm2Xp9Rv` (AWS secret access key shape), a
 * bare 56-char mixed-case token, and a base64 blob. Those have no vendor prefix
 * to pattern-match, so they are reachable ONLY through the generic
 * entropy heuristic, which is always `medium`. They are also the single most
 * common shape of self-hosted credential.
 *
 * The medium tier is affordable here: over the detector's own 100-line
 * false-positive corpus it fires zero times, and over 393 strings from the
 * bundled provider registry it fires zero times (see `strict` below for why
 * that number depends on the placeholder filter).
 */
export type GuardTier = 'strict' | 'high-only';

function tierAccepts(tier: GuardTier, confidence: Detection['confidence']): boolean {
  return tier === 'strict' || confidence === 'high';
}

/** Minimum run of one repeated character before a span reads as filler. */
const MIN_PLACEHOLDER_RUN = 8;
/** …and how much of the span that run must cover. */
const MIN_PLACEHOLDER_RUN_RATIO = 0.4;

function longestRun(span: string): number {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const ch of span) {
    run = ch === previous ? run + 1 : 1;
    previous = ch;
    if (run > best) best = run;
  }
  return best;
}

function collapseRuns(span: string): string {
  return span.replace(/([\s\S])\1{2,}/g, '$1');
}

/**
 * `sk-XXXXXXXXXXXXXXXXXXXX`, `AKIA11111111111111XX`, `ghp_XXXX…` — filler, not
 * credentials. This filter is load-bearing rather than a nicety: 26 of the 393
 * strings shipped in `packages/registry/providers/*.json` are placeholders of
 * exactly this shape, and `Broker.declare` copies a registry `format` onto any
 * entry that omits one. Without the filter, declaring any registry-known key —
 * and every `envseal init` on a project that mentions one — would fail closed
 * against our own bundled data.
 *
 * Padding a real credential with filler does not get past this. The run has to
 * dominate the span (≥40%), and even then the span is re-scanned with its runs
 * collapsed: `sk-proj-<20 real chars>XXXXXXXXXXXXXXXXXXXX` still matches after
 * collapsing, so it is not treated as a placeholder. Random key material
 * essentially never contains an 8-character run — for a 48-character base62
 * body the probability is on the order of 1e-11.
 */
function isRunPlaceholder(span: string): boolean {
  const run = longestRun(span);
  if (run < MIN_PLACEHOLDER_RUN) return false;
  if (run / span.length < MIN_PLACEHOLDER_RUN_RATIO) return false;
  return detect(collapseRuns(span)).length === 0;
}

/**
 * Words that carry no key material, so a span built only from them is a
 * template rather than a value. This exists for one shape that the run filter
 * cannot see: `postgresql://USERNAME:PASSWORD@localhost:5432/mydb`, which the
 * connection-string pattern matches at high confidence and which is the most
 * natural thing to write in a DATABASE_URL description.
 *
 * Matching is per whole segment, never per substring, so a real password sitting
 * next to these words still rejects: `postgres://user:hunter2ThisIsReal@host`
 * has a segment that is not in this list.
 */
const PLACEHOLDER_WORDS = new Set([
  'postgres', 'postgresql', 'mysql', 'mongodb', 'srv', 'redis', 'amqp',
  'user', 'username', 'pass', 'password', 'passwd', 'host', 'hostname',
  'localhost', 'port', 'dbname', 'database', 'example', 'com', 'net', 'org',
  'your', 'key', 'apikey', 'token', 'secret', 'value', 'redacted', 'changeme',
  'placeholder', 'foo', 'bar', 'baz', 'qux', 'xxx', 'yyy', 'zzz', 'abc',
  'none', 'null', 'here', 'todo', 'sample', 'dummy',
]);

function isVocabularyPlaceholder(span: string): boolean {
  const segments = span.match(/[A-Za-z0-9]{3,}/g);
  if (segments === null) return false;
  return segments.every((segment) => PLACEHOLDER_WORDS.has(segment.toLowerCase()));
}

function isPlaceholder(span: string): boolean {
  return isRunPlaceholder(span) || isVocabularyPlaceholder(span);
}

export interface SecretFinding {
  /** Dotted path of the offending field, e.g. `entries[0].format.example`. */
  path: string;
  /** The detector's pattern label. Describes the SHAPE, never the text. */
  label: string;
  confidence: Detection['confidence'];
}

/**
 * The first credential-shaped span in `text`, or null. The returned finding
 * deliberately carries no offsets and no excerpt — an offset pair plus a
 * repeatable call is itself a substring oracle over the input.
 */
export function scanText(path: string, text: string, tier: GuardTier): SecretFinding | null {
  for (const detection of detect(text)) {
    if (!tierAccepts(tier, detection.confidence)) continue;
    if (isPlaceholder(text.slice(detection.start, detection.end))) continue;
    return { path, label: detection.label, confidence: detection.confidence };
  }
  return null;
}

function scanOptional(
  path: string,
  text: string | undefined,
  tier: GuardTier,
): SecretFinding | null {
  return text === undefined ? null : scanText(path, text, tier);
}

/**
 * Every free-text string on a parsed entry that reaches `env.schema.jsonc`.
 *
 * `key` is scanned at `high-only`, alone among the fields. It is the one field
 * whose content is not the caller's to rephrase — it is the environment
 * variable's actual name — so a false positive there is unfixable rather than
 * merely annoying, and the generic entropy tier does produce them:
 * `STRIPE_WEBHOOK_SIGNING_SECRET_V2` is a plausible name that scores as a
 * medium-confidence hit. High-confidence patterns still apply, so a key named
 * `AKIAT7QLM2XP9RV4NC3B` is rejected. Non-string fields (booleans, numbers,
 * `sink`, `verify.method`) cannot carry a value past their zod types and are
 * not scanned.
 */
export function scanManifestEntry(entry: ManifestEntry, basePath: string): SecretFinding | null {
  const at = (field: string): string => `${basePath}.${field}`;

  const findings: Array<SecretFinding | null> = [
    scanText(at('key'), entry.key, 'high-only'),
    scanText(at('description'), entry.description, 'strict'),
    scanOptional(at('format.pattern'), entry.format?.pattern, 'strict'),
    scanOptional(at('format.example'), entry.format?.example, 'strict'),
    scanOptional(at('provider.id'), entry.provider?.id, 'strict'),
    scanOptional(at('provider.name'), entry.provider?.name, 'strict'),
    scanOptional(at('provider.signupUrl'), entry.provider?.signupUrl, 'strict'),
    scanOptional(at('provider.docsUrl'), entry.provider?.docsUrl, 'strict'),
    scanOptional(at('provider.rotateUrl'), entry.provider?.rotateUrl, 'strict'),
    scanOptional(at('verify.url'), entry.verify?.url, 'strict'),
  ];

  const scopes = entry.provider?.scopesNeeded ?? [];
  for (const [index, scope] of scopes.entries()) {
    findings.push(scanText(at(`provider.scopesNeeded[${index}]`), scope, 'strict'));
  }

  // Header VALUES are the sharpest edge on the entry: `{ "Authorization":
  // "Bearer sk-proj-…" }` is both a manifest leak and a live credential handed
  // to whatever host verify.url points at. Header NAMES are scanned too; they
  // are equally free text.
  for (const [name, template] of Object.entries(entry.verify?.headerTemplate ?? {})) {
    findings.push(scanText(at(`verify.headerTemplate.${name}`), name, 'strict'));
    findings.push(scanText(at(`verify.headerTemplate.${name}`), template, 'strict'));
  }

  return findings.find((finding): finding is SecretFinding => finding !== null) ?? null;
}

export function secretInDeclarationError(finding: SecretFinding): SepError {
  return new SepError({
    code: 'SEP_VALUE_IN_REQUEST',
    userMessage:
      `Refusing to declare: ${finding.path} looks like a real credential (${finding.label}). ` +
      'Manifest fields are metadata and are committed to git, so they must never contain a value. ' +
      'Describe the key instead — "starts with sk-proj-", or a placeholder such as ' +
      '"sk-proj-XXXXXXXXXXXXXXXXXXXX" — and let the user supply the value through the prompt ' +
      'that env_request opens. A value must never appear in a declaration.',
    details: { field: finding.path, detected: finding.label, confidence: finding.confidence },
  });
}

export function secretInRequestError(finding: SecretFinding): SepError {
  return new SepError({
    code: 'SEP_VALUE_IN_REQUEST',
    userMessage:
      `Refusing to open a request: ${finding.path} looks like a real credential (${finding.label}). ` +
      'The reason is written to the audit log, which records key names only. ' +
      'Say why the key is needed without quoting any value — env_request exists so that the user ' +
      'types the value into a prompt you never see, so it must never be in the request itself.',
    details: { field: finding.path, detected: finding.label, confidence: finding.confidence },
  });
}
