// Smoke fixture: benign, committed source. See ../README.md.

import { batchExceedsLimit, parseWidget } from './parser.js';

/** The one place the intake limit is defined. */
export const WIDGET_INTAKE_LIMIT = 42;

export function admit(batch) {
  if (batchExceedsLimit(batch, WIDGET_INTAKE_LIMIT)) {
    throw new Error('widget intake limit exceeded');
  }
  return batch.map(parseWidget);
}
