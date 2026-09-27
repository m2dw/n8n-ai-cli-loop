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

Staged verification does not change the `npm test` requirement. When an operator opts a session into `stagedVerification`, every loop and final stage runs the entire required set of non-test checks (`npm run typecheck`, `npm run package`), and with a `testSuite` binding the test entry leaves both for the changed-file stages. Issue #1155 retired the group-selection policy, so there is no selection adapter, no `.ai-cli-loop/verification.json` project file and no setting that can omit a required check.

**During the implemented loop, Stage 1 is selected-file verification: the test files this Issue added or modified, union the files an earlier Stage 2 left failing — nothing else. Final completion requires full verification: the whole suite runs at the approved head, after Stage 1 has passed and code review has approved the same revision, and only the completion that records that complete, passing full run publishes `status:stack-ready`.** A green Stage 1 is never a green suite, and nothing may report it as one.

`npm run test:files` is the same Jest invocation as `npm test` without the `pretest` rebuild; it exists so a bound stage builds once through `setupCommand` instead of once per suite launch. It is not a substitute for the `npm test` requirement above.

A session that binds a suite command spelled differently from the `npm test` an Issue requires must say so in the binding (`"requirementCommands": ["npm test"]`, issue #1166). The requirement then reads *pending Stage 2* instead of missing, and only a complete, passing Stage 2 at the approved revision discharges it — the declaration grants nothing by itself. **No session in this repository binds the suite today**, so none of this is switched on here: the loop still runs `npm test` as an ordinary verification command on every cycle, and adding the binding is an operator step the runner cannot take.

CI and any full project verification run outside the loop remain an **independent final safeguard**. Stage 1 narrows what the loop runs before approval; it never narrows what CI runs, and no staged setting can make it do so. See `docs/staged-verification-operations.md` §6, `docs/changed-file-verification-validation.md` and `docs/changed-file-verification-contract.md`.

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
