import type { SecretValue } from '@envseal/protocol';
import { unsafeSecretToUtf8 } from './sinks/dotenv.js';

export interface RedactResult {
  text: string;
  count: number;
}

const MIN_SECRET_LENGTH = 8;
const PREFIX_MIN_LENGTH = 20;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret]);
  const encoded = Buffer.from(secret, 'utf8');
  const base64 = encoded.toString('base64');
  variants.add(base64);
  variants.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
  variants.add(encodeURIComponent(secret));
  const jsonEscaped = JSON.stringify(secret);
  if (jsonEscaped.length >= 3) variants.add(jsonEscaped.slice(1, -1));
  for (let length = PREFIX_MIN_LENGTH; length <= secret.length; length++) {
    variants.add(secret.slice(0, length));
  }
  return [...variants];
}

export function redact(
  text: string,
  secrets: Iterable<SecretValue>,
  labels?: Map<SecretValue, string>,
): RedactResult {
  const variantToToken = new Map<string, string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    const label = labels?.get(secret);
    const token = label === undefined ? '«redacted»' : `«redacted:${label}»`;
    for (const variant of variantsOf(unsafeSecretToUtf8(secret))) {
      if (!variantToToken.has(variant)) variantToToken.set(variant, token);
    }
  }
  if (variantToToken.size === 0) return { text, count: 0 };
  const patterns = [...variantToToken.entries()].sort((a, b) => b[0].length - a[0].length);
  const defaultToken = '«redacted»';
  const regex = new RegExp(patterns.map(([variant]) => escapeRegExp(variant)).join('|'), 'g');
  let count = 0;
  const result = text.replace(regex, (match) => {
    count++;
    return variantToToken.get(match) ?? defaultToken;
  });
  return { text: result, count };
}
