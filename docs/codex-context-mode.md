# Codex context-mode (issue #376)

This document describes how to enable **context-mode** for Codex agent
invocations managed by n8n-ai-cli-loop. It applies to Codex as an implementation
agent (`codex exec`) and as a review agent (`codex review`). It does **not**
change Claude or Gemini/Antigravity behavior.

## Why it is operator-configured, not guessed

Codex CLI and plugin behavior changes quickly, and the exact context-mode
config key/profile depends on the operator's installed Codex build and plugins
(e.g. the `context-mode@context-mode` marketplace entry). To avoid sending an
unverified config key, this workflow never hard-codes the context-mode
invocation form. Instead, the operator declares the form they have **verified
against their own Codex build** and it is passed verbatim to `codex exec` /
`codex review`.

The workflow does **not** install Codex plugins as a side effect. If your
context-mode form requires a plugin or a named Codex profile, install/configure
it as operator setup first, then point the session config at it.

## Configuration surface

Add an optional `codex.contextMode` block to a session in `sessions.json`:

```jsonc
{
  "sessionId": "addon-dev",
  // …
  "codex": {
    "contextMode": {
      "enabled": true,
      // Verified `-c key=value` overrides, passed as `-c <entry>` to codex.
      "config": ["context_mode=on"],
      // Optional: a Codex profile selected via `--profile <name>`.
      "profile": "context-mode"
    }
  }
}
```

Fields (`CodexContextModeConfig`):

- `enabled` (boolean, required) — master switch. When `false`/absent the Codex
  command argv is unchanged.
- `config` (string[], optional) — operator-verified Codex config overrides. Each
  entry must be a literal `key=value` string and is applied as `-c <entry>` to
  both `codex exec` and `codex review`.
- `profile` (string, optional) — a Codex profile name, applied as
  `--profile <name>`.

When `enabled` is `true`, **at least one** of `config` or `profile` must be
present — otherwise there is no invocation form to pass and the configuration is
rejected at load time.

### Environment override

`CODEX_CONTEXT_MODE` toggles context-mode on/off and overrides the session
switch, mirroring how `CODEX_EFFORT` overrides the resolved effort tier:

- `CODEX_CONTEXT_MODE=off` (also `false`/`0`/`no`) — force context-mode off even
  when the session enables it. Resolved metadata records
  `contextMode: "unset", contextModeSource: "env"`.
- `CODEX_CONTEXT_MODE=on` (also `true`/`1`/`yes`) — force context-mode on. The
  invocation form still comes from `session.codex.contextMode`; turning it on via
  the env var with no configured form is a clear error, not a guess.
- Any other value is rejected with a clear error.

## Resolved profile metadata

The resolved implementation/review profile (written to the run's
`implementation-context.json` / `review-context.json`) records, for every agent:

- `provider` — company/provider (`anthropic`, `openai`, `google`).
- `model`, `effort` — as before.

For Codex it additionally records context-mode status so billed runs can be
audited later:

- `contextMode` — `"enabled"` or `"unset"` (Codex); `"n/a"` for Claude/Gemini.
- `contextModeSource` — `"session"`, `"env"`, or `"default"`.
- `contextModeConfig` — the resolved overrides applied (e.g.
  `["profile=context-mode", "context_mode=on"]`), present only when enabled.

## Verifying readiness: `admin context-mode status`

Enabling context-mode in `sessions.json` is necessary but not sufficient: it
only takes effect for phases whose **assigned agent is Codex**. Use the
operator-facing readiness command to confirm, before a billable run, that the
session is wired the way you expect:

```sh
node dist/cli/admin.js context-mode status --session-id addon-dev
```

It resolves the session and reports, for the default flow:

- the agent assigned to implementation / review / research / conflict-resolution,
- whether each assigned agent can use context-mode in this codebase (only Codex
  on implementation/review can — Claude/Gemini phases are `n/a`; Codex assigned to
  the Gemini-only research or Claude-only conflict-resolution phase is reported
  `unsupported`, because that run fails before context-mode could apply),
- the configured `codex.contextMode` and the effective `CODEX_CONTEXT_MODE`
  override,
- the **exact** Codex argv additions that would be spliced into `codex exec` /
  `codex review`, reported per phase so `--profile` placement matches the real
  invocation,
- a single verdict: `enabled`, `disabled`, `invalid`, or `not_applicable`.

The verdict is computed with the same resolver the real implementation/review
runs use, so the diagnostic can never disagree with what a run would do. An
invalid configuration is reported here with the resolver's own actionable error
message, so you fix it before a billed Codex run fails.

### Example output (enabled)

For a session whose review phase is Codex and whose `codex.contextMode` is
enabled with `config: ["context_mode=on"]`:

```
Codex context-mode readiness for session "addon-dev"
  status: ENABLED

  Assigned agents (default flow):
    implementation       claude   context-mode n/a
    review               codex    context-mode applicable
    research             (none)   context-mode n/a
    conflict_resolution  claude   context-mode n/a

  codex.contextMode.enabled: true
  codex.contextMode.config: context_mode=on
  CODEX_CONTEXT_MODE: (unset)

  Resolved: enabled (source: session)
  Codex argv additions (per phase):
    review               codex review … -c context_mode=on

  context-mode is enabled for review and will be passed to codex exec/codex review verbatim.
```

The argv additions are reported **per phase** because placement is phase-specific: a
`--profile <name>` is a global Codex option that the review handler emits *before* the
`review` subcommand (`codex --profile <name> review …`), while the implementation
handler appends it after `codex exec`. So a profile-based config renders, for example:

```
  Codex argv additions (per phase):
    implementation       codex exec … --profile ctx -c context_mode=on
    review               codex --profile ctx review … -c context_mode=on
```

(`…` stands in for each phase's other, non-context-mode arguments — the reasoning
effort `-c` and, for review, `--base <branch>`.)

### Verdicts

- **enabled** — at least one assigned agent is Codex and a valid invocation form
  is resolved; `phaseArgv` shows exactly what Codex receives, per phase.
- **disabled** — Codex is assigned to a phase but context-mode is off (no config
  and/or `CODEX_CONTEXT_MODE=off`).
- **invalid** — the configuration would fail a run (e.g. an unrecognized
  `CODEX_CONTEXT_MODE` value, or `CODEX_CONTEXT_MODE=on` with no configured
  form). The guidance line carries the actionable fix. A statically invalid
  `codex.contextMode` block (enabled-but-empty, malformed `key=value`) is
  rejected even earlier, when `sessions.json` is loaded.
- **not_applicable** — no assigned agent runs Codex, so context-mode does not
  apply. This also covers the case where Codex is assigned only to a phase whose
  handler does not run Codex (research is Gemini-only, conflict-resolution is
  Claude-only): that phase is shown `context-mode unsupported` and the guidance
  warns the run would fail with `Unsupported … agent: codex`. If a
  `codex.contextMode` block is nonetheless enabled, the guidance warns it will not
  be used until Codex is assigned to implementation or review.

An assignment profile that **explicitly** sets `conflict_resolution` to an
unsupported agent (e.g. `codex`) fail-closes a real run before any phase executes.
The readiness command deliberately does **not** abort on that: it still reports
every phase, marks `conflict_resolution` as `context-mode unsupported`, and surfaces
the misconfiguration in the guidance — so `--json` always returns the stable status
payload rather than `{ok:false}`, letting you catch the broken assignment here.

Pass `--json` for a stable machine payload (the same fields), suitable for tests
and future UI use.

### Dry-run / CLI validation

The command does **not** invoke Codex to "try" the configured context-mode form.
There is no reliable no-work Codex invocation that both exercises the operator's
`-c`/`--profile` form **and** avoids a billable run, and guessing such a form
would violate the "never guess the invocation form" contract above. The command
therefore fails closed to **static** validation.

`--probe-cli` adds a safe, non-billable `codex --version` check that confirms the
Codex binary is installed. It deliberately does **not** assert that Codex accepts
the configured profile/override — you must still verify that form against your
own Codex build, as described above.

## Behavior summary

- **Unset** — no `codex.contextMode` (or `enabled: false`, or
  `CODEX_CONTEXT_MODE=off`): the Codex argv is unchanged; metadata records
  context-mode as `unset`.
- **Enabled** — `codex exec` and `codex review` receive the configured
  `--profile`/`-c` arguments (alongside the existing
  `-c model_reasoning_effort=…`).
- **Invalid/unavailable** — an enabled-but-empty form, a malformed `config`
  entry, or an invalid `CODEX_CONTEXT_MODE` value fails the run with a clear
  error **before** the agent is invoked, so a billed Codex run never proceeds
  silently without the context-mode the operator configured.
