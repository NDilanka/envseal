import { SepError } from '@envseal/protocol';
import type { Sink } from './types.js';
import { DotenvSink } from './dotenv.js';
import { keychainSink } from './keychain.js';
import { vaultSink } from './vault.js';
import { onepasswordSink } from './onepassword.js';
import { dopplerSink } from './doppler.js';
import { sopsSink } from './sops.js';

/**
 * Placeholder for sinks with no adapter module at all. The CLI-backed stubs
 * (vault, onepassword, doppler, sops) refuse because their provider
 * prerequisite is missing; this one refuses because nobody has written the
 * sink yet.
 */
class UnimplementedSink implements Sink {
  constructor(readonly id: string) {}

  async available(): Promise<boolean> {
    return false;
  }

  async read(): Promise<null> {
    throw new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `The ${this.id} sink adapter is not implemented yet.`,
    });
  }

  async write(): Promise<void> {
    throw new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `The ${this.id} sink adapter is not implemented yet.`,
    });
  }

  async remove(): Promise<boolean> {
    throw new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `The ${this.id} sink adapter is not implemented yet.`,
    });
  }
}

const sinks = new Map<string, Sink>([
  ['dotenv', new DotenvSink()],
  ['keychain', keychainSink],
  ['sops', sopsSink],
  ['onepassword', onepasswordSink],
  ['doppler', dopplerSink],
  ['vault', vaultSink],
  ['external', new UnimplementedSink('external')],
]);

export function getSink(id: string): Sink {
  const sink = sinks.get(id);
  if (!sink) {
    throw new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `Unknown sink: ${id}`,
    });
  }
  return sink;
}

export function allSinks(): Sink[] {
  return Array.from(sinks.values());
}
