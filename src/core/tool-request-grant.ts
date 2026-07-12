/**
 * Scoped Tool Request grants (issue #301).
 *
 * A Tool Request handoff (see core/tool-request.ts) parks a task at
 * `ready_for_human` because an agent needs a command outside its allowed tool
 * set. There are two distinct operator responses:
 *
 *   - `manual-done` (core/tool-request.ts + `admin tool-request resolve`): the
 *     operator already ran the command themselves; the task is simply requeued.
 *   - GRANT (this module + `admin tool-request grant`): the operator approves
 *     the orchestrator running ONE specific, exact command on their behalf, in a
 *     tightly scoped way, then requeues.
 *
 * A grant is deliberately narrow so an approval can never be silently reused for
 * a different command, repo, or issue, and can never become a standing
 * wildcard:
 *
 *   - Scoped to a session, an issue/task, a phase, the repo root (cwd), AND the
 *     normalized command hash. ALL must match for the grant to authorize an
 *     execution.
 *   - Exact-command only: matching is by the hash of the normalized command, so
 *     a different command — even a superset like adding a flag — does not match.
 *   - One-shot by default (`maxUses` = 1) with a short TTL, so a grant cannot be
 *     reused indefinitely.
 *
 * The exact command itself is sensitive (it may embed credentials or host
 * paths); like {@link ToolRequest}, the grant keeps the exact `command` in local
 * metadata only and exposes a redacted {@link ToolRequestGrant.displayCommand}
 * for any public surface.
 *
 * This module is pure: it computes hashes, builds grant records, and decides
 * whether a grant authorizes a candidate execution. Actually running the granted
 * command (handler-owned, OUTSIDE the agent permission surface) lives with the
 * orchestrator caller (see `admin tool-request grant`).
 */

import { createHash } from "crypto";
import type { TaskPhase } from "./task.js";

/** Default one-shot use count: a grant authorizes exactly one execution. */
export const GRANT_DEFAULT_MAX_USES = 1;

/** Default time-to-live for a grant (15 minutes). Short by design: an approval
 * should be acted on promptly, not linger as a standing permission. */
export const GRANT_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Hard ceilings so an operator typo (or hostile input) cannot mint an
 * effectively unbounded standing grant — a non-goal of this feature. */
export const GRANT_MAX_USES_CEILING = 10;
export const GRANT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize a command for hashing/comparison: trim, and collapse runs of
 * *insignificant* whitespace to single spaces. Exact-command matching is
 * intentionally strict — only unquoted space/tab runs, which the shell treats
 * as intra-command token separators, are collapsed, so `npm  install   left-pad`
 * and `npm install left-pad` match, but `npm install left-pad --save-dev` does
 * not.
 *
 * Unquoted newlines are deliberately NOT collapsed: `/bin/sh -c` parses a
 * newline as a command terminator (like `;`), so `cmd1\ncmd2` runs two commands
 * while `cmd1 cmd2` runs one. Treating `\n` as ordinary whitespace would let
 * them hash identically and allow an operator-supplied `--command` whose
 * newlines were accidentally collapsed to match a materially different command.
 *
 * Whitespace inside single/double quotes (and after a backslash escape) is
 * semantically significant — it is part of an argument's value, not a token
 * separator — so it is preserved verbatim. Without this, `printf "a    b"` and
 * `printf "a b"` would hash identically and an operator-supplied `--command`
 * could match a different exact command, defeating the exact-command scoping
 * guarantee.
 */
export function normalizeCommand(command: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;
  let pendingSpace = false;
  // Emit a single separating space before the next significant char, but never
  // at the very start (leading whitespace is trimmed).
  const flushPendingSpace = (): void => {
    if (pendingSpace && result.length > 0) result += " ";
    pendingSpace = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // Inside double quotes a backslash escapes the next character, so an
      // escaped `"` (`\"`) is a literal quote, NOT the end of the quoted region.
      // Emit the pair verbatim and keep scanning inside the quotes; otherwise the
      // trailing `"` would be read as the close quote and following whitespace
      // collapsed as if unquoted, letting `printf "a\"    b"` and
      // `printf "a\" b"` hash identically. Single quotes have no escapes — a
      // backslash there is a literal character — so this only applies to `"`.
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        result += ch + command[i + 1];
        i++;
        continue;
      }
      // Otherwise everything (including whitespace) is verbatim.
      result += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // A backslash escapes the next character (e.g. `printf a\ b`); both are
      // significant, so emit them verbatim.
      flushPendingSpace();
      result += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flushPendingSpace();
      result += ch;
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      // Unquoted space/tab is an intra-command token separator: collapse runs to
      // one space. Other whitespace (notably newlines) is NOT a token separator
      // — `/bin/sh -c` parses an unquoted newline as a command terminator, so
      // `cmd1\ncmd2` (two commands) must not hash the same as `cmd1 cmd2` (one
      // command). Such characters fall through and are preserved verbatim below.
      pendingSpace = true;
      continue;
    }
    flushPendingSpace();
    result += ch;
  }
  // A trailing unquoted whitespace run (pendingSpace) is dropped → trimmed.
  return result;
}

/** SHA-256 hex digest of the normalized command — the exact-command fingerprint
 * stored on a grant (so the grant record itself need not be compared verbatim). */
export function hashCommand(command: string): string {
  return createHash("sha256").update(normalizeCommand(command)).digest("hex");
}

/** The narrow scope a grant is bound to. Every field must match a candidate
 * execution for the grant to authorize it. */
export interface ToolRequestGrantScope {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  /** Repository root (cwd) the command is approved to run in. */
  repoRoot: string;
  /** {@link hashCommand} of the approved exact command. */
  commandHash: string;
}

export interface ToolRequestGrant extends ToolRequestGrantScope {
  /** The exact approved command. Sensitive: local metadata/artifacts only,
   * never posted verbatim to a public comment. Use {@link displayCommand}. */
  command: string;
  /** Redacted, public-safe form of {@link command}. */
  displayCommand: string;
  /** Operator/automation identity that issued the grant. */
  grantedBy: string;
  grantedAt: string;
  /** ISO timestamp after which the grant no longer authorizes execution. */
  expiresAt: string;
  /** Maximum number of executions this grant authorizes (default 1). */
  maxUses: number;
  /** Executions consumed so far. A grant is exhausted once `uses >= maxUses`. */
  uses: number;
  /** Result of the last execution, recorded after the orchestrator runs it. */
  lastResult?: {
    exitCode: number;
    executedAt: string;
  };
}

/** A candidate execution the orchestrator wants to authorize against a grant. */
export interface GrantCandidate {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  repoRoot: string;
  /** The exact command (unhashed) about to run. */
  command: string;
}

export type GrantMatchResult =
  | { ok: true }
  | {
      ok: false;
      reason: "scope-mismatch" | "expired" | "exhausted";
      detail: string;
    };

export interface CreateGrantInput {
  sessionId: string;
  issueNumber: number;
  phase: TaskPhase;
  repoRoot: string;
  /** The exact approved command. */
  command: string;
  /** Public-safe redacted form (caller supplies it via redactCommand). */
  displayCommand: string;
  grantedBy: string;
  /** Defaults to {@link GRANT_DEFAULT_TTL_MS}; clamped to (0, GRANT_MAX_TTL_MS]. */
  ttlMs?: number;
  /** Defaults to {@link GRANT_DEFAULT_MAX_USES}; clamped to [1, GRANT_MAX_USES_CEILING]. */
  maxUses?: number;
  /** Current time (ISO). Defaults to now. */
  now?: string;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Build a fresh, unused grant from the approved command and scope. */
export function createToolRequestGrant(input: CreateGrantInput): ToolRequestGrant {
  const now = input.now ?? new Date().toISOString();
  const ttlMs = clamp(input.ttlMs ?? GRANT_DEFAULT_TTL_MS, 1, GRANT_MAX_TTL_MS);
  const maxUses = clamp(input.maxUses ?? GRANT_DEFAULT_MAX_USES, 1, GRANT_MAX_USES_CEILING);
  const expiresAt = new Date(new Date(now).getTime() + ttlMs).toISOString();
  return {
    sessionId: input.sessionId,
    issueNumber: input.issueNumber,
    phase: input.phase,
    repoRoot: input.repoRoot,
    commandHash: hashCommand(input.command),
    command: input.command,
    displayCommand: input.displayCommand,
    grantedBy: input.grantedBy,
    grantedAt: now,
    expiresAt,
    maxUses,
    uses: 0,
  };
}

/** Whether the grant is still usable, independent of any candidate. */
export function grantStatus(
  grant: Pick<ToolRequestGrant, "expiresAt" | "maxUses" | "uses">,
  now: string = new Date().toISOString(),
): "active" | "expired" | "exhausted" {
  if (grant.uses >= grant.maxUses) return "exhausted";
  if (new Date(now).getTime() >= new Date(grant.expiresAt).getTime()) return "expired";
  return "active";
}

/**
 * Decide whether `grant` authorizes running `candidate` now. Authorization
 * requires ALL of: identical session, issue, phase, repo root, and command hash
 * (exact-command only), AND that the grant is neither expired nor exhausted.
 *
 * Scope is checked before lifetime so a mismatched command/repo/issue is always
 * reported as `scope-mismatch` (it was never this grant's business) rather than
 * leaking that some grant happened to be expired.
 */
export function grantMatches(
  grant: ToolRequestGrant,
  candidate: GrantCandidate,
  now: string = new Date().toISOString(),
): GrantMatchResult {
  if (grant.sessionId !== candidate.sessionId) {
    return { ok: false, reason: "scope-mismatch", detail: "different session" };
  }
  if (grant.issueNumber !== candidate.issueNumber) {
    return { ok: false, reason: "scope-mismatch", detail: "different issue" };
  }
  if (grant.phase !== candidate.phase) {
    return { ok: false, reason: "scope-mismatch", detail: "different phase" };
  }
  if (grant.repoRoot !== candidate.repoRoot) {
    return { ok: false, reason: "scope-mismatch", detail: "different repo root" };
  }
  if (grant.commandHash !== hashCommand(candidate.command)) {
    return { ok: false, reason: "scope-mismatch", detail: "different command" };
  }

  const status = grantStatus(grant, now);
  if (status === "expired") {
    return { ok: false, reason: "expired", detail: `grant expired at ${grant.expiresAt}` };
  }
  if (status === "exhausted") {
    return {
      ok: false,
      reason: "exhausted",
      detail: `grant already used ${grant.uses}/${grant.maxUses} time(s)`,
    };
  }
  return { ok: true };
}
