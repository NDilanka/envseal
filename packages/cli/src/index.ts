export { EXIT, exitCodeForError, exitCodeForOutcome } from './exit-codes.js';
export { emit, fail } from './output.js';
export { finish, registerDisposable } from './exit.js';
export type { ProtectionTier, HostInfo } from './host.js';
export { detectHost } from './host.js';
export { parseArgs, createBroker, outcomeForKey, hasInteractiveSurface } from './cli-utils.js';
export { makeProbeApprover } from './probe-approval.js';
