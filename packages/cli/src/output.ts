import { isSepError } from '@envseal/protocol';
import { EXIT, exitCodeForError } from './exit-codes.js';
import { finish } from './exit.js';

/**
 * Emit output in JSON or human-readable format.
 * When json is true, prints ONLY a single JSON object to stdout.
 * When false, prints the human string.
 */
export function emit(json: boolean, human: string, data: unknown): void {
  if (json) {
    console.log(JSON.stringify(data, null, 0));
  } else {
    console.log(human);
  }
}

/**
 * Print an error and set the appropriate exit code.
 * Never prints a stack trace or a secret value.
 *
 * This does NOT return `never` any more: termination is deferred so the event
 * loop can drain (see exit.ts). Every caller must be the last statement in its
 * catch block, or must `return` immediately after.
 */
export function fail(json: boolean, error: unknown): void {
  // A failure path must never default to "OK". The previous initialiser was 0,
  // so throwing anything that was not a SepError, an Error, or a string exited
  // the process successfully while printing an error message.
  let code: number = EXIT.UNSATISFIED;
  let userMessage = 'An unexpected error occurred.';
  let retriable = false;
  let errorCode: string | undefined;

  if (isSepError(error)) {
    code = exitCodeForError(error);
    userMessage = error.userMessage;
    retriable = error.retriable;
    errorCode = error.code;
  } else if (error instanceof Error) {
    userMessage = error.message;
  } else if (typeof error === 'string') {
    userMessage = error;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          code: errorCode ?? 'UNKNOWN',
          userMessage,
          retriable,
        },
        null,
        0,
      ),
    );
  } else {
    console.error(`Error: ${userMessage}`);
  }

  finish(code);
}
