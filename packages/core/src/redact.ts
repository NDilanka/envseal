import type { SecretValue } from '@envseal/protocol';
import { unsafeSecretToUtf8 } from './sinks/dotenv.js';

export interface RedactResult {
  text: string;
  count: number;
}

/**
 * Values shorter than this are never redacted. Rejecting such a value at entry
 * is the manifest's job (PLAN §7.4); the floor exists here because a 7-byte
 * filter removes far more innocent output than real material. Documented in
 * docs/residual-risks.md §9.1.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Detection window. Any contiguous run of at least WINDOW characters of any
 * variant form is redacted — which subsumes the historical rule "every prefix
 * of length >= 20 is redacted" and additionally covers suffixes and interior
 * fragments (W2-F5: a value split across a line break emerges as a prefix and a
 * suffix; only the prefix used to be caught).
 */
const WINDOW = 20;

/**
 * The whole index is a chained hash table over WINDOW-length windows of every
 * variant. Memory is bounded by this many entries (16 bytes each, so ~64 MB at
 * the cap) no matter how long the stored values are. Past the cap the index
 * becomes sparse (see `strideFor`) rather than growing — it never allocates an
 * unbounded pattern, which is what used to abort the process (W2-F9: the old
 * implementation compiled every prefix into one regex alternation, O(N^2) in
 * pattern source, and V8's regex compiler aborts rather than throwing).
 */
const MAX_INDEX_ENTRIES = 4_000_000;

/**
 * Cap on candidate windows examined per text position. Only entries whose full
 * 32-bit hash equals the probe's count against it, so the cap is reached only
 * when a value contains 64+ windows with an identical hash — i.e. a highly
 * repetitive value, whose windows are byte-identical, so the first candidate
 * already verifies. Bucket collisions between *different* windows are skipped
 * by a single integer compare and never consume the budget.
 */
const MAX_PROBES = 64;

/**
 * A label is emitted verbatim into the output stream, so it must be a plain
 * identifier and nothing else. Manifest keys already match a stricter pattern
 * (`/^[A-Z][A-Z0-9_]{0,63}$/`); anything outside this one falls back to the
 * unlabelled token rather than being escaped, because a caller supplying such a
 * "key name" is not describing a real key.
 */
const SAFE_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const GENERIC_TOKEN = '«redacted»';

const HASH_BASE = 33_554_467;
const HASH_MIX = 0x9e3779b1 | 0;

const HASH_TOP = (() => {
  let acc = 1;
  for (let i = 1; i < WINDOW; i++) acc = Math.imul(acc, HASH_BASE);
  return acc >>> 0;
})();

function hashWindow(s: string, at: number): number {
  let h = 0;
  for (let i = 0; i < WINDOW; i++) h = (Math.imul(h, HASH_BASE) + s.charCodeAt(at + i)) >>> 0;
  return h;
}

function rollWindow(h: number, outCode: number, inCode: number): number {
  return (Math.imul((h - Math.imul(outCode, HASH_TOP)) >>> 0, HASH_BASE) + inCode) >>> 0;
}

/**
 * The forms a child process is most likely to emit a value in. Deliberately
 * NOT exhaustive: a process that chooses to can always encode a value in a form
 * no filter matches (PLAN §2.3 non-goal). See docs/residual-risks.md §9.1.
 */
function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret]);
  const encoded = Buffer.from(secret, 'utf8');
  const base64 = encoded.toString('base64');
  variants.add(base64);
  variants.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
  variants.add(encodeURIComponent(secret));
  const jsonEscaped = JSON.stringify(secret);
  if (jsonEscaped.length >= 3) variants.add(jsonEscaped.slice(1, -1));
  const hex = encoded.toString('hex');
  variants.add(hex);
  variants.add(hex.toUpperCase());
  return [...variants];
}

interface VariantSource {
  source: string;
  token: string;
}

interface VariantIndex {
  sources: string[];
  tokens: string[];
  head: Int32Array;
  entryNext: Int32Array;
  entryVariant: Uint32Array;
  entryOffset: Uint32Array;
  entryHash: Uint32Array;
  shift: number;
}

/**
 * Index every `stride`-th window. Offset 0 is always indexed, so a whole
 * variant and every prefix of it are always detected exactly. With stride > 1
 * the *interior* detection length degrades from WINDOW to WINDOW + stride - 1;
 * that only happens for values large enough that a dense index would exceed
 * MAX_INDEX_ENTRIES (roughly 370 KB of stored value).
 */
function strideFor(variants: VariantSource[]): number {
  let dense = 0;
  for (const v of variants) dense += v.source.length - WINDOW + 1;
  if (dense <= MAX_INDEX_ENTRIES) return 1;
  return Math.ceil(dense / MAX_INDEX_ENTRIES);
}

function buildIndex(variants: VariantSource[], stride: number): VariantIndex {
  let total = 0;
  for (const v of variants) total += Math.ceil((v.source.length - WINDOW + 1) / stride);
  let bits = 1;
  while (1 << bits < total && bits < 24) bits++;
  const size = 1 << bits;
  const head = new Int32Array(size);
  const entryNext = new Int32Array(total);
  const entryVariant = new Uint32Array(total);
  const entryOffset = new Uint32Array(total);
  const entryHash = new Uint32Array(total);
  const shift = 32 - bits;

  let entry = 0;
  for (let vi = 0; vi < variants.length; vi++) {
    const src = variants[vi]!.source;
    const windows = src.length - WINDOW + 1;
    let h = hashWindow(src, 0);
    for (let off = 0; off < windows; off++) {
      if (off % stride === 0) {
        entryVariant[entry] = vi;
        entryOffset[entry] = off;
        entryHash[entry] = h;
        entry++;
      }
      if (off + 1 < windows) h = rollWindow(h, src.charCodeAt(off), src.charCodeAt(off + WINDOW));
    }
  }

  // Chain in descending entry order so each bucket's head is its LOWEST offset.
  // For a repetitive value every window hashes alike; starting from the lowest
  // offset gives the match the most room to extend forward, which keeps a long
  // run one redaction rather than a chain of fragments.
  for (let i = total - 1; i >= 0; i--) {
    const bucket = Math.imul(entryHash[i]!, HASH_MIX) >>> shift;
    entryNext[i] = head[bucket]!;
    head[bucket] = i + 1;
  }

  return {
    sources: variants.map((v) => v.source),
    tokens: variants.map((v) => v.token),
    head,
    entryNext,
    entryVariant,
    entryOffset,
    entryHash,
    shift,
  };
}

interface Match {
  back: number;
  forward: number;
  variant: number;
}

const NO_MATCH: Match = { back: 0, forward: 0, variant: -1 };

/**
 * Longest run of any indexed variant anchored at text[p..p+WINDOW). `maxBack`
 * bounds the backwards extension so a match can never reach into text that has
 * already been emitted.
 */
function findMatch(idx: VariantIndex, text: string, p: number, h: number, maxBack: number): Match {
  const bucket = Math.imul(h, HASH_MIX) >>> idx.shift;
  const textLength = text.length;
  let best = NO_MATCH;
  let probes = 0;
  for (let e = idx.head[bucket]!; e !== 0; e = idx.entryNext[e - 1]!) {
    const ei = e - 1;
    if (idx.entryHash[ei] !== h) continue;
    if (++probes > MAX_PROBES) break;
    const vi = idx.entryVariant[ei]!;
    const src = idx.sources[vi]!;
    const off = idx.entryOffset[ei]!;

    let k = 0;
    while (k < WINDOW && src.charCodeAt(off + k) === text.charCodeAt(p + k)) k++;
    if (k < WINDOW) continue;

    let forward = WINDOW;
    while (
      off + forward < src.length &&
      p + forward < textLength &&
      src.charCodeAt(off + forward) === text.charCodeAt(p + forward)
    ) {
      forward++;
    }
    let back = 0;
    while (
      back < maxBack &&
      off - back > 0 &&
      src.charCodeAt(off - back - 1) === text.charCodeAt(p - back - 1)
    ) {
      back++;
    }
    if (forward + back > best.forward + best.back) best = { back, forward, variant: vi };
  }
  return best;
}

/**
 * One replaced region of the input. Spans from a single scan never overlap
 * (the scan is greedy and bounds backward extension by the previous span's
 * end); spans from the dense second pass can overlap the first pass's, which
 * mergeSpans resolves.
 */
interface Span {
  start: number;
  end: number;
  token: string;
}

/**
 * Greedy left-to-right scan. At each position try an indexed WINDOW match
 * (extended as far as it verifiably reaches), then the shorter literals.
 * `maxBack` bounds the backwards extension so a match can never reach into
 * text that has already been claimed by an earlier span.
 */
function scanSpans(
  idx: VariantIndex | null,
  literals: VariantSource[],
  text: string,
): Span[] {
  const spans: Span[] = [];
  const length = text.length;
  let copied = 0;
  let p = 0;
  let h = 0;
  let hashValid = false;

  while (p < length) {
    let start = p;
    let end = p;
    let token = '';

    if (idx !== null && p + WINDOW <= length) {
      if (!hashValid) {
        h = hashWindow(text, p);
        hashValid = true;
      }
      const match = findMatch(idx, text, p, h, p - copied);
      if (match.variant >= 0) {
        start = p - match.back;
        end = p + match.forward;
        token = idx.tokens[match.variant]!;
      }
    }

    // Only reached when no indexed variant matched: every indexed match is at
    // least WINDOW long and every literal is shorter than WINDOW.
    if (end === start) {
      for (const literal of literals) {
        if (text.startsWith(literal.source, p)) {
          start = p;
          end = p + literal.source.length;
          token = literal.token;
          break;
        }
      }
    }

    if (end > start) {
      spans.push({ start, end, token });
      copied = end;
      p = end;
      hashValid = false;
      continue;
    }

    if (hashValid && p + WINDOW < length) {
      h = rollWindow(h, text.charCodeAt(p), text.charCodeAt(p + WINDOW));
    } else {
      hashValid = false;
    }
    p++;
  }

  return spans;
}

/** Merge overlapping spans, keeping the earliest span's token and the union's
 *  extent. Input spans may come from two different scans of the same text. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  let current = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start <= current.end) {
      if (next.end > current.end) current = { ...current, end: next.end };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

const WHITESPACE_RE = /\s/;

/**
 * Replace every occurrence of a stored value — and of the encodings in
 * `variantsOf` — with an opaque token. Cost is O(text) in time and O(value) in
 * memory, both bounded; nothing here compiles a pattern, so no input length can
 * abort the process.
 *
 * When the text contains whitespace, a second scan runs over a
 * whitespace-stripped dense copy with a dense→original index map (W2-F5: a
 * value split across a line break emerges as a short head plus a suffix, and
 * neither fragment alone may reach the detection window). Matches found dense
 * are mapped back to original offsets and merged with the first pass's spans,
 * so the joined fragments redact as one region including the separator.
 */
export function redact(
  text: string,
  secrets: Iterable<SecretValue>,
  labels?: Map<SecretValue, string>,
): RedactResult {
  const indexable: VariantSource[] = [];
  const literals: VariantSource[] = [];
  const seen = new Set<string>();

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    const label = labels?.get(secret);
    const token =
      label !== undefined && SAFE_LABEL.test(label) ? `«redacted:${label}»` : GENERIC_TOKEN;
    for (const source of variantsOf(unsafeSecretToUtf8(secret))) {
      if (source.length === 0 || seen.has(source)) continue;
      seen.add(source);
      if (source.length >= WINDOW) indexable.push({ source, token });
      else literals.push({ source, token });
    }
  }

  if (indexable.length === 0 && literals.length === 0) return { text, count: 0 };
  literals.sort((a, b) => b.source.length - a.source.length);
  const idx = indexable.length > 0 ? buildIndex(indexable, strideFor(indexable)) : null;

  let spans = scanSpans(idx, literals, text);

  if (WHITESPACE_RE.test(text)) {
    const map: number[] = [];
    let dense = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (!WHITESPACE_RE.test(ch)) {
        map.push(i);
        dense += ch;
      }
    }
    if (dense.length !== text.length) {
      for (const s of scanSpans(idx, literals, dense)) {
        // A dense span [s.start, s.end) maps back to the original positions of
        // its first and last characters; any whitespace between them is part of
        // the split value and is swallowed into the redacted region.
        spans.push({ start: map[s.start]!, end: map[s.end - 1]! + 1, token: s.token });
      }
      spans = mergeSpans(spans);
    }
  }

  if (spans.length === 0) return { text, count: 0 };
  let out = '';
  let copied = 0;
  for (const span of spans) {
    out += text.slice(copied, span.start) + span.token;
    copied = span.end;
  }
  out += text.slice(copied);
  return { text: out, count: spans.length };
}
