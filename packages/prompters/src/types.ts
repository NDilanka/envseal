import { randomBytes } from 'node:crypto';
import type { SecretValue } from '@envseal/protocol';

export interface PromptKeyRequest {
  key: string;
  description: string;
  providerName?: string;
  signupUrl?: string;
  docsUrl?: string;
  formatHint?: string;
  pattern?: string;
  optional?: boolean;
}

export interface PromptRequest {
  ticket: string;
  nonce: string;
  projectRoot: string;
  reason: string;
  keys: PromptKeyRequest[];
  timeoutMs: number;
}

export type PromptKeyResult =
  | { key: string; outcome: 'entered'; value: SecretValue }
  | { key: string; outcome: 'skipped' | 'cancelled' | 'timeout' };

export interface PromptResponse {
  ticket: string;
  results: PromptKeyResult[];
}

export type PrompterId = 'loopback-browser' | 'native-dialog' | 'ide' | 'tty' | 'none';

export interface Prompter {
  readonly id: PrompterId;
  available(): Promise<boolean>;
  prompt(req: PromptRequest): Promise<PromptResponse>;
  cancel(ticket: string): Promise<void>;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function makeDisplayNonce(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) {
      break;
    }
    out += CROCKFORD.charAt(byte & 0x1f);
    if (i === 3) {
      out += '-';
    }
  }
  return out;
}