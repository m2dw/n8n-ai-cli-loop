# Widget pipeline (smoke fixture)

Committed benign content for the opt-in real-CLI research smoke test
(`test/antigravity-cli-smoke.test.js`, docs/antigravity-workspace-settings.md
§11.1). Nothing here is a secret, and nothing names a real repository, account,
or credential.

The pipeline has two parts:

- `src/parser.js` turns a raw record into a widget.
- `src/registry.js` decides how many widgets may be held at once.

The intake limit is not written down here. It is defined once in the registry
and referenced by the note in `docs/limits.md`, so answering a question about it
means enumerating the tree, searching for the symbol, and reading both files.
