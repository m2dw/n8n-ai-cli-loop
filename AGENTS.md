# Agent Instructions

This repository maintains a generated n8n workflow for a GitHub Issue driven AI development loop.

## Core Contract

- Treat `docs/n8n-thin-parent-workflow.json` and `docs/n8n-thin-child-workflow.json` as generated output.
- Make workflow changes in `scripts/build-parent-child-workflow.mjs`, then run `npm run build:parent-child-workflow`.
- Keep the parent/child workflow JSONs synchronized with generator output.
- Run `npm test` before finishing changes.
- Do not commit `.n8n-artifacts/` or `node_modules/`.

## Editing Guidance

- Keep worker phase changes narrowly scoped. Each phase command is embedded into an n8n Execute Command node, so quoting and exit status behavior are part of the public contract.
- Preserve `__N8N_AI_DEV_RUN_ID__` handling. The workflow generator converts this placeholder into an n8n expression using `$execution.id`.
- Preserve lock ownership checks when releasing `.n8n-artifacts/repo.lock`.
- Failure phases that claim an issue should write `session.skip=true`, release the lock if owned, and exit nonzero when n8n should show a real phase failure.
- Skip guards for unrelated lanes or already skipped sessions should exit `0`.
- Keep tests close to command contracts. If a shell command string changes intentionally, update tests to assert the new behavior rather than deleting coverage.

## Verification

Use:

```sh
npm test
```

For workflow-only regeneration:

```sh
npm run build:parent-child-workflow
```

This project's `npm run package` intentionally regenerates the workflow JSONs. It exists so the same n8n automation contract can verify this repository too.

## Operational Boundaries

- Do not merge PRs from automation.
- Do not remove human handoff labels without preserving the intended lane transition.
- Do not weaken the single-worker lock or stale-lock recovery without adding tests.
- Do not make the workflow depend on n8n preventing overlapping executions; the local lock is the concurrency control.
- Do not modify `AGENTS.md`, `docs/phase-contracts.md`, or any other behavioral specification document unless the implementing issue explicitly requests a specification change. See the [No-Direct-Edits Policy](#no-direct-edits-policy) below for the full set of distinctions.

## No-Direct-Edits Policy

Because an automation-owned Issue/PR branch may be active at any time — and the agent may not be able to determine with certainty whether one is active — specification changes, workflow behavior changes, and operational policy changes must be created as Issues first. Do not directly edit the current branch for those changes unless the current task Issue explicitly requests that exact change.

**Scope of this policy:**

- Specification documents (`AGENTS.md`, `docs/phase-contracts.md`, and any file that defines agent or workflow behavior contracts)
- Workflow behavior (phase logic, routing, labeling, scheduling, concurrency control)
- Operational policy (what agents are allowed or forbidden to do)

**Action distinctions:**

| Action | Policy |
|---|---|
| Normal inspection and diagnosis (reading files, checking status, reviewing history) | Allowed at any time. |
| Local recovery actions explicitly requested by the operator | Allowed when scoped to the operator's request and reported in the task artifact. |
| Code, spec, or workflow behavior changes | Must enter through a dedicated Issue unless the current implementing Issue explicitly requests that exact change. |
| Generated output updates (e.g. `docs/n8n-thin-parent-workflow.json`, `docs/n8n-thin-child-workflow.json`) | Allowed only as part of the implementing Issue that owns the behavioral change. |
| Discovered specification gaps or policy improvements | Record in the result artifact and open a follow-up Issue; do not edit inline. |
