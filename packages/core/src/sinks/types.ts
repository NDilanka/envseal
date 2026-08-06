import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';

export interface Sink {
  readonly id: string;
  available(paths: ProjectPaths): Promise<boolean>;
  read(paths: ProjectPaths, key: string): Promise<SecretValue | null>;
  write(paths: ProjectPaths, key: string, value: SecretValue): Promise<void>;
  remove(paths: ProjectPaths, key: string): Promise<boolean>;
}
