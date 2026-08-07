# Limits (smoke fixture)

The widget intake limit is enforced by `admit()` in `src/registry.js`, which
rejects a batch larger than `WIDGET_INTAKE_LIMIT`. The check itself is
`batchExceedsLimit()` in `src/parser.js`.

The numeric value is deliberately not repeated here: a reader has to open the
registry to state it.
