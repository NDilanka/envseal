import { createHmac } from 'node:crypto';

declare const brand: unique symbol;

export type SecretValue = Buffer & { readonly [brand]: 'SecretValue' };

export function asSecret(buf: Buffer): SecretValue {
  return buf as SecretValue;
}

export function secretFromUtf8(s: string): SecretValue {
  return asSecret(Buffer.from(s, 'utf8'));
}

export function zero(s: SecretValue): void {
  s.fill(0);
}

export function secretLength(s: SecretValue): number {
  return s.length;
}

const BUCKETS: ReadonlyArray<{ max: number; label: string }> = [
  { max: 15, label: '<16' },
  { max: 31, label: '16-31' },
  { max: 47, label: '32-47' },
  { max: 63, label: '48-63' },
  { max: 95, label: '64-95' },
  { max: 127, label: '96-127' },
  { max: Number.MAX_SAFE_INTEGER, label: '128+' },
];

export function lengthBucket(s: SecretValue): string {
  const len = s.length;
  for (const bucket of BUCKETS) {
    if (len <= bucket.max) {
      return bucket.label;
    }
  }
  return '128+';
}

export function fingerprint(s: SecretValue, salt: Buffer): string {
  const digest = createHmac('sha256', salt).update(s).digest('hex');
  return `fp_${digest.slice(0, 8)}`;
}
