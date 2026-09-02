import { isLinearishRegex, SepError } from '@envseal/protocol';

/** Compile a manifest format.pattern after the protocol's linearish safety check. */
export function compileSafePattern(pattern: string): RegExp {
  if (!isLinearishRegex(pattern)) {
    throw new SepError({ code: 'SEP_PATTERN_UNSAFE' });
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new SepError({ code: 'SEP_PATTERN_UNSAFE' });
  }
}
