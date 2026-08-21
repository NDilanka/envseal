export type {
  Prompter,
  PromptRequest,
  PromptResponse,
  PromptKeyRequest,
  PromptKeyResult,
} from './types.js';
export { makeDisplayNonce } from './types.js';
export { selectPrompter, allPrompters } from './registry.js';
export type { SelectOptions } from './registry.js';

// W3-05: the concrete surfaces are part of the public API. Without these a
// Tier-2 consumer cannot construct a LoopbackPrompter with options — it cannot
// suppress the browser launch or observe the listening port — and the repo's
// own probes had to deep-import `dist/loopback.js`, which is not a public entry
// point and would break under a package.json `exports` map without subpaths.
export { LoopbackPrompter } from './loopback.js';
export type { LoopbackPrompterOptions, LoopbackResult } from './loopback.js';
export { IdePrompter } from './ide.js';
export { NativePrompter } from './native.js';
export { NonePrompter } from './none.js';
export { TtyPrompter } from './tty.js';