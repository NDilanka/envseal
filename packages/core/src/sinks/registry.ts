import { SepError } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import type { Sink } from './types.js';
import { DotenvSink } from './dotenv.js';
import { keychainSink } from './keychain.js';

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
  ['sops', new UnimplementedSink('sops')],
  ['onepassword', new UnimplementedSink('onepassword')],
  ['doppler', new UnimplementedSink('doppler')],
  ['vault', new UnimplementedSink('vault')],
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
