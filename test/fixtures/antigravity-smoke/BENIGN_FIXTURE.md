# Antigravity smoke fixture

This file is committed benign content used by the opt-in real-CLI smoke test
(`test/antigravity-cli-smoke.test.js`, docs/antigravity-workspace-settings.md
§11.1). The test copies it into a temporary git workspace, prepares the bounded
read-only permission profile, and asks the installed `agy` to read it headlessly.

The marker below is what the test looks for in the CLI's output. It is not a
secret and carries no repository, account, or credential information.

MARKER: antigravity-smoke-fixture-4f2b8c1d
