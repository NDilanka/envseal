import { allPatterns } from './patterns.js';
import { shannonEntropy, charsetClasses } from './entropy.js';
import { isExcluded } from './exclusions.js';

export interface Detection {
  start: number;
  end: number;
  patternId: string;
  providerId?: string;
  confidence: 'high' | 'medium';
  label: string;
}

/** Minimum token length before the generic entropy heuristic will consider it. */
const MIN_GENERIC_LENGTH = 24;
const MIN_ENTROPY = 3.5;
const MIN_CHARSET_CLASSES = 2;

/**
 * Characters that terminate a candidate token. Deliberately does not include
 * `-`, `_`, `.`, `+`, `/` or `=` — those appear inside real credentials
 * (base64, JWTs, connection strings) and splitting on them would shred a key
 * into fragments that individually fall under the length threshold.
 */
const TOKEN_SPLIT_RE = /[\s"'`<>()[\]{},;|\\]+/;

function scanPatterns(text: string): Detection[] {
  const out: Detection[] = [];
  for (const pattern of allPatterns()) {
    // allPatterns() hands back fresh RegExp objects, so lastIndex starts at 0.
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const detection: Detection = {
        start: match.index,
        end: match.index + match[0].length,
        patternId: pattern.id,
        confidence: pattern.confidence,
        label: pattern.label,
      };
      if (pattern.providerId !== undefined) detection.providerId = pattern.providerId;
      out.push(detection);
      // Zero-length matches would spin forever.
      if (match[0].length === 0) pattern.regex.lastIndex += 1;
    }
  }
  return out;
}

function scanGeneric(text: string, covered: Detection[]): Detection[] {
  const out: Detection[] = [];
  let cursor = 0;
  for (const raw of text.split(TOKEN_SPLIT_RE)) {
    const start = text.indexOf(raw, cursor);
    if (start < 0 || raw.length === 0) {
      cursor += raw.length;
      continue;
    }
    const end = start + raw.length;
    cursor = end;

    if (raw.length < MIN_GENERIC_LENGTH) continue;
    // Skip anything a high-confidence pattern already claimed; re-reporting it
    // as a generic hit would only downgrade a precise label.
    if (covered.some((d) => start < d.end && end > d.start)) continue;
    if (shannonEntropy(raw) < MIN_ENTROPY) continue;
    if (charsetClasses(raw) < MIN_CHARSET_CLASSES) continue;
    if (isExcluded(raw, { before: text.slice(0, start), after: text.slice(end) })) continue;

    out.push({
      start,
      end,
      patternId: 'generic:high-entropy',
      confidence: 'medium',
      label: 'high-entropy string',
    });
  }
  return out;
}

/**
 * Merge overlapping detections, preferring high confidence, then the longer
 * span. Returns a sorted, non-overlapping list.
 */
function merge(detections: Detection[]): Detection[] {
  const rank = (d: Detection): number => (d.confidence === 'high' ? 1 : 0);
  const sorted = [...detections].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.end - b.start - (a.end - a.start);
  });

  const out: Detection[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || d.start >= last.end) {
      out.push(d);
      continue;
    }
    // Overlap: keep whichever wins on confidence, then on span length.
    const better =
      rank(d) > rank(last) || (rank(d) === rank(last) && d.end - d.start > last.end - last.start);
    if (better) out[out.length - 1] = d;
  }
  return out;
}

export function detect(text: string): Detection[] {
  const high = scanPatterns(text);
  const generic = scanGeneric(text, high);
  return merge([...high, ...generic]);
}

export function redactDetections(text: string, detections: Detection[]): string {
  // Walk backwards so earlier offsets stay valid as we splice.
  const ordered = [...detections].sort((a, b) => b.start - a.start);
  let out = text;
  for (const d of ordered) {
    const token = d.confidence === 'high' ? `«redacted:${d.label}»` : '«redacted-secret»';
    out = out.slice(0, d.start) + token + out.slice(d.end);
  }
  return out;
}

export function hasSecret(text: string): boolean {
  return detect(text).length > 0;
}

export { shannonEntropy, charsetClasses } from './entropy.js';
export { allPatterns } from './patterns.js';
export { isExcluded, exclusionReason } from './exclusions.js';
export type { SecretPattern } from './patterns.js';
export type { ExclusionContext } from './exclusions.js';
