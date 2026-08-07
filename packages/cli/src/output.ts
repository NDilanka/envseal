import { SepError, isSepError } from '@envseal/protocol';
import { exitCodeForError } from './exit-codes.js';

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
 * Print an error and exit with the appropriate exit code.
 * Never prints a stack trace or a secret value.
 */
export function fail(json: boolean, error: unknown): never {
  let code = 0;
  let userMessage = 'An unexpected error occurred.';
  let retriable = false;
  let errorCode: string | undefined;

  if (isSepError(error)) {
    code = exitCodeForError(error);
    userMessage = error.userMessage;
    retriable = error.retriable;
    errorCode = error.code;
  } else if (error instanceof Error) {
    code = 1;
    userMessage = error.message;
  } else if (typeof error === 'string') {
    code = 1;
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

  process.exit(code);
}
