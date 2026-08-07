// Smoke fixture: benign, committed source. See ../README.md.

/**
 * Turn a raw intake record into a widget.
 *
 * The intake limit itself lives in ./registry.js as WIDGET_INTAKE_LIMIT; this
 * module only reports whether a batch is over it.
 */
export function parseWidget(record) {
  return { id: String(record.id), label: String(record.label ?? 'unnamed') };
}

export function batchExceedsLimit(batch, limit) {
  return batch.length > limit;
}
