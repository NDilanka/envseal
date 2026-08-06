import { IdePrompter } from './ide.js';
import { LoopbackPrompter } from './loopback.js';
import { NativePrompter } from './native.js';
import { NonePrompter } from './none.js';
import { TtyPrompter } from './tty.js';
import type { Prompter } from './types.js';

export interface SelectOptions {
  /** Force a specific surface. Throws if it is not available. */
  prefer?: Prompter['id'];
  /** Allow the raw-TTY adapter, which collides with a harness TUI. */
  allowTty?: boolean;
}

let ide: IdePrompter | null = null;
let loopback: LoopbackPrompter | null = null;
let native: NativePrompter | null = null;
let tty: TtyPrompter | null = null;
const none = new NonePrompter();

export function allPrompters(): Prompter[] {
  loopback ??= new LoopbackPrompter();
  native ??= new NativePrompter();
  ide ??= new IdePrompter();
  tty ??= new TtyPrompter();
  return [loopback, native, ide, tty, none];
}

/**
 * Select the first available surface in the order mandated by PLAN.md §5.3:
 * prefer -> ide -> native-dialog (SEP_PREFER_NATIVE) -> loopback-browser ->
 * tty (opt-in) -> none. A `CI` environment forces `none` unless `prefer`
 * names a concrete surface.
 */
export async function selectPrompter(opts: SelectOptions = {}): Promise<Prompter> {
  if (opts.prefer !== undefined) {
    const preferred = allPrompters().find((p) => p.id === opts.prefer);
    if (preferred === undefined) {
      throw new Error(`unknown prompter id: ${opts.prefer}`);
    }
    if (await preferred.available()) {
      return preferred;
    }
    throw new Error(`preferred prompter is not available: ${opts.prefer}`);
  }

  if (process.env.CI !== undefined) {
    return none;
  }

  ide ??= new IdePrompter();
  if (await ide.available()) {
    return ide;
  }

  if (process.env.SEP_PREFER_NATIVE !== undefined) {
    native ??= new NativePrompter();
    if (await native.available()) {
      return native;
    }
  }

  loopback ??= new LoopbackPrompter();
  if (await loopback.available()) {
    return loopback;
  }

  if (opts.allowTty === true) {
    tty ??= new TtyPrompter();
    if (await tty.available()) {
      return tty;
    }
  }

  return none;
}