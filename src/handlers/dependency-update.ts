import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandRunner } from "./command-runner.js";
import { parseShellTokens, boundVerificationOutput } from "./verification.js";
import { runDependencySync } from "./dependency-sync.js";
import type { DependencySyncOutcome } from "./dependency-sync.js";
import type { DependencySyncConfig } from "../core/session.js";

// ---------------------------------------------------------------------------
// Trusted dependency-update path (issue #302;
// docs/tool-request-and-dependency-sync.md §3.5)
//
// A non-interactive implementation agent that needs to add or bump a dependency
// cannot run `npm install <pkg>@<version>` itself, so today it emits a generic
// Tool Request and stops — and re-emits the same request every run because the
// package state never changes. This module gives that specific shape of request
// a first-class, dependency-only workflow path: instead of escalating every time,
// the handler applies the requested version to the *manifest* (a JSON data edit,
// not command execution) and then regenerates the lockfile with the EXACT,
// session-pinned dependency-sync command (`runDependencySync`).
//
// The security boundary from §4 is preserved: the agent's requested command is
// never executed and never selects or composes what runs. The request supplies
// only DATA (package name + version range); the one command that runs is still
// the fixed `dependencySync.command` the session owns. A request that cannot be
// satisfied safely (no session config, an unsupported ecosystem, a missing
// version, a manifest error, an already-satisfied dependency, or a sync failure)
// does NOT silently loop — it falls back to a clear human handoff.
// ---------------------------------------------------------------------------

/** A single package the agent asked to install, parsed from the request. */
export interface RequestedPackage {
  /** Package name, including any `@scope/` prefix. */
  name: string;
  /** Version range/spec the agent requested (the part after `name@`). */
  version?: string;
}

/** A parsed dependency-update command (e.g. `npm install left-pad@^1.3.0`). */
export interface DependencyUpdateRequest {
  /** Ecosystem the command targets (e.g. `npm`). */
  manager: string;
  /** Packages named on the command line. Empty for a bare lockfile-regen install. */
  packages: RequestedPackage[];
  /**
   * Manifest section selected by an explicit save-target flag — e.g.
   * `--save-dev` → `devDependencies`, `--save-peer` → `peerDependencies`. Absent
   * when no section flag was given, so the manager's default section applies.
   */
  section?: string;
  /**
   * A save-target/scope/target-changing flag the trusted manifest-edit path
   * cannot faithfully represent (`--no-save` / `--save=false`, `--global`/`-g` /
   * `--location=global`, or a workspace/prefix target such as
   * `--workspace`/`-w`/`--prefix`/`-C`). When
   * present the request is routed to the generic Tool Request handoff
   * (`unsupported-flag`) rather than silently editing the root `package.json`
   * with the wrong semantics or against the wrong manifest.
   */
  unsupportedFlag?: string;
}

/** Why a request was NOT taken onto the trusted path (→ generic Tool Request handoff). */
export type DependencyUpdateSkipReason =
  // The command is not a recognized dependency-install command at all.
  | "not-a-dependency-update"
  // No `dependencySync` is configured/enabled for the session.
  | "not-configured"
  // The ecosystem is recognized but this build cannot safely apply it (no manifest
  // editor for it, or the session's dependencySync is configured for a different
  // ecosystem's manifest).
  | "unsupported-manager"
  // The command carries a save-target/scope flag (`--no-save` / `--save=false`,
  // `--global` / `--location=global`) or a target-changing flag
  // (`--workspace`/`--prefix`) whose semantics a root manifest edit cannot
  // represent → generic handoff.
  | "unsupported-flag"
  // At least one requested package has no explicit version to pin.
  | "missing-version"
  // At least one requested version is a mutable dist-tag (`latest`, `beta`, …) or
  // an unbounded wildcard (`*`/`x`) rather than a concrete semver version/range.
  | "non-concrete-version";

/** Why an attempted update did not pass (→ dependency-specific human handoff). */
export type DependencyUpdateFailureKind =
  // Every requested package is already at the requested version AND the working
  // tree is clean (no trigger path dirty), so there is nothing to sync.
  | "unchanged"
  // The manifest is missing or not valid JSON.
  | "manifest-error"
  // The handler-owned dependency-sync command failed (non-zero exit, timeout, or
  // a refused lifecycle-running command in safe mode).
  | "sync-failed";

/** A package actually written to the manifest by the update. */
export interface AppliedPackage {
  name: string;
  version: string;
  /** Manifest section it was written to (`dependencies`, `devDependencies`, …). */
  section: string;
  /** The version that was there before, when the package already existed. */
  previousVersion?: string;
}

/** The request was not eligible for the trusted path → generic Tool Request handoff. */
export interface DependencyUpdateSkipped {
  handled: false;
  reason: DependencyUpdateSkipReason;
}

/** The manifest+lockfile were brought to the requested state; the run may continue. */
export interface DependencyUpdateApplied {
  handled: true;
  passed: true;
  manager: string;
  /** Repo-relative manifest path that was edited. */
  manifestPath: string;
  /** Packages written to the manifest. */
  packages: AppliedPackage[];
  /** Outcome of the handler-owned lockfile sync. */
  sync: DependencySyncOutcome;
}

/** The request was recognized but could not be satisfied → dependency-specific handoff. */
export interface DependencyUpdateFailed {
  handled: true;
  passed: false;
  manager: string;
  /** Repo-relative manifest path that was (or would be) edited. */
  manifestPath: string;
  /** Packages applied before the failure (empty when it failed before/at the edit). */
  packages: AppliedPackage[];
  /** Outcome of the handler-owned lockfile sync, when it ran. */
  sync?: DependencySyncOutcome;
  failure: { kind: DependencyUpdateFailureKind; message: string };
}

export type DependencyUpdateResult =
  | DependencyUpdateSkipped
  | DependencyUpdateApplied
  | DependencyUpdateFailed;

// ---------------------------------------------------------------------------
// Ecosystem registry
//
// Each entry pins the package-manager binary(ies), the install subcommand
// token(s) that introduce a dependency, and the manifest the session's
// dependencySync must target for the ecosystem to be supported. `applyManifest`
// is the data-only editor that writes the requested version into the manifest;
// an ecosystem without one is parse-only (recognized so the request routes to a
// clear handoff rather than a confusing generic one) but cannot be applied here.
// ---------------------------------------------------------------------------

interface ManagerSpec {
  manager: string;
  bins: readonly string[];
  installSubcommands: readonly string[];
  manifest: string;
  /**
   * Maps an explicit save-target flag to the manifest section it selects (e.g.
   * `--save-dev` → `devDependencies`). Flags not listed here keep the default
   * section. A new package whose flag is unmapped would otherwise be silently
   * written to the default section with the wrong semantics, so any flag that
   * MUST change the section is either listed here or in `rejectFlags`.
   */
  sectionFlags?: Readonly<Record<string, string>>;
  /**
   * Boolean scope flags whose semantics a root manifest edit cannot represent
   * (`--no-save` installs nothing into the manifest; `--global` installs outside
   * the project). Because they are boolean, an explicit falsy value
   * (`--global=false`) cancels the flag, so the truthiness check applies. A
   * request carrying a truthy one is routed to the generic handoff rather than
   * applied with the wrong semantics.
   */
  rejectFlags?: readonly string[];
  /**
   * Boolean flags whose ENABLED form is the eligible default but whose explicit
   * falsy form is the unsupported one — the inverse of `rejectFlags`. npm's
   * `--save` saves to the manifest (the default this path relies on), but
   * `--save=false` is the equivalent of `--no-save`: it must not be applied as a
   * manifest entry. A request carrying one with a falsy value is routed to the
   * generic handoff.
   */
  rejectWhenFalsyFlags?: readonly string[];
  /**
   * String-valued flags that are only unsupported for SPECIFIC values — npm's
   * `--location=global` (and `--location=user`) is the modern equivalent of a
   * global install, while `--location=project` is the ordinary local install this
   * path supports. Maps a flag name to the values that make it unsupported; a
   * request carrying a listed value is routed to the generic handoff.
   */
  rejectValueFlags?: Readonly<Record<string, readonly string[]>>;
  /**
   * String-valued, target-changing flags (`--workspace`/`--prefix`) that
   * redirect the save to a different package's manifest. Their value is a target
   * (a workspace name or directory), not a boolean, so a falsy-looking value
   * (`--prefix=false`, `--workspace=0`) is still a real target and must be
   * rejected. A request carrying any of these — regardless of value — is routed
   * to the generic handoff rather than applied against the wrong manifest.
   */
  rejectTargetFlags?: readonly string[];
  /**
   * Apply the requested packages to the manifest as a pure data edit. Returns the
   * applied packages, or a `manifest-error` when the manifest is missing/invalid.
   * `unchanged` (empty applied list) means every package was already at the
   * requested version. `section` is the explicitly-requested section (from a
   * save-target flag) or undefined to use the manager's default.
   */
  applyManifest?: (
    manifestAbsPath: string,
    packages: RequestedPackage[],
    section: string | undefined,
  ) => { ok: true; applied: AppliedPackage[] } | { ok: false; error: string };
}

const NPM_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * Write the requested versions into a `package.json`, preferring the section a
 * package already lives in and otherwise adding it to the explicitly-requested
 * `section` (mapped from a save-target flag such as `--save-dev` or
 * `--save-peer`) or `dependencies` when none was given. This is a JSON data edit
 * only — it never runs a package manager, so it cannot execute lifecycle scripts.
 */
function applyNpmManifest(
  manifestAbsPath: string,
  packages: RequestedPackage[],
  requestedSection: string | undefined,
): { ok: true; applied: AppliedPackage[] } | { ok: false; error: string } {
  if (!existsSync(manifestAbsPath)) {
    return { ok: false, error: `Manifest not found at ${manifestAbsPath}` };
  }
  let raw: string;
  try {
    raw = readFileSync(manifestAbsPath, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read manifest: ${err instanceof Error ? err.message : String(err)}` };
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Manifest is not a JSON object" };
    }
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const applied: AppliedPackage[] = [];
  for (const pkg of packages) {
    const version = pkg.version!; // callers guarantee an explicit version
    // Find the section the package currently lives in, if any.
    let existingSection: string | undefined;
    let previousVersion: string | undefined;
    for (const candidate of NPM_DEPENDENCY_SECTIONS) {
      const block = manifest[candidate];
      if (block && typeof block === "object" && !Array.isArray(block) && pkg.name in (block as object)) {
        existingSection = candidate;
        const existing = (block as Record<string, unknown>)[pkg.name];
        previousVersion = typeof existing === "string" ? existing : undefined;
        break;
      }
    }
    // An explicit save target wins: npm moves an already-installed package to the
    // requested block. Otherwise keep where it already lives, else default.
    const section = requestedSection ?? existingSection ?? "dependencies";
    // No version bump and no section move → record nothing so an all-unchanged
    // request is detected by the empty applied list.
    if (previousVersion === version && existingSection === section) continue;

    // Moving sections (explicit save target differs from the current block) →
    // remove the stale entry so the manifest matches the requested install.
    if (existingSection && existingSection !== section) {
      const oldBlock = manifest[existingSection];
      if (oldBlock && typeof oldBlock === "object" && !Array.isArray(oldBlock)) {
        delete (oldBlock as Record<string, unknown>)[pkg.name];
      }
    }

    let block = manifest[section];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      block = {};
      manifest[section] = block;
    }
    (block as Record<string, unknown>)[pkg.name] = version;
    applied.push({ name: pkg.name, version, section, ...(previousVersion ? { previousVersion } : {}) });
  }

  if (applied.length === 0) {
    // Nothing changed — surface as `unchanged` rather than writing an identical file.
    return { ok: true, applied };
  }

  try {
    // 2-space indent + trailing newline matches the npm convention. Preserve a
    // trailing newline if the original had one (the common case).
    writeFileSync(manifestAbsPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } catch (err) {
    return { ok: false, error: `Could not write manifest: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, applied };
}

const MANAGERS: readonly ManagerSpec[] = [
  {
    manager: "npm",
    bins: ["npm"],
    installSubcommands: ["install", "i", "add"],
    manifest: "package.json",
    sectionFlags: {
      "--save-prod": "dependencies",
      "-P": "dependencies",
      "--save-dev": "devDependencies",
      "-D": "devDependencies",
      "--save-optional": "optionalDependencies",
      "-O": "optionalDependencies",
      "--save-peer": "peerDependencies",
    },
    // Boolean flags: a falsy value (`--global=false`) cancels the flag.
    rejectFlags: ["--no-save", "--global", "-g", "--workspaces"],
    // `--save` is the eligible default, but its falsy form (`--save=false`) is the
    // equivalent of `--no-save` and must not write to the root manifest.
    rejectWhenFalsyFlags: ["--save"],
    // `--location=global`/`--location=user` are the modern equivalents of a global
    // install; only `--location=project` is the local install this path supports.
    rejectValueFlags: { "--location": ["global", "user"] },
    // Target-changing flags: these redirect the install to a different
    // workspace/prefix manifest, so applying the edit to the session's root
    // `package.json` would commit the dependency to the wrong package. They take
    // a string target, so even a falsy-looking value (`--prefix=false`,
    // `--workspace=0`) is a real target — reject regardless of value.
    rejectTargetFlags: ["--workspace", "-w", "--prefix", "-C"],
    applyManifest: applyNpmManifest,
  },
  // Recognized so a `cargo add foo@1` request routes to a clear handoff instead of
  // a confusing generic one; no manifest editor here, so it cannot be applied
  // (a Cargo session may still use the generic Tool Request path).
  {
    manager: "cargo",
    bins: ["cargo"],
    installSubcommands: ["add"],
    manifest: "Cargo.toml",
    sectionFlags: { "--dev": "dev-dependencies" },
  },
];

/**
 * True when a requested version is a CONCRETE semver version or range — one that
 * pins actual version numbers (`1.2.3`, `^1.3.0`, `~1.2`, `>=1.0.0 <2.0.0`,
 * `1.x`, `v1.2.3`) rather than a mutable npm dist-tag (`latest`, `beta`, `next`,
 * `canary`) or an unbounded wildcard (`*`, `x`). A concrete semver spec always
 * BEGINS with a version number — optionally behind a range operator
 * (`^ ~ > >= < <= =`) and/or a leading `v` — so its first significant character
 * is a digit. Dist-tags begin with a letter even when they embed digits
 * (`beta2`, `next-18`), and npm forbids a dist-tag that parses as valid semver,
 * so a leading digit cannot collide with a tag. Merely containing a digit is not
 * enough: that would accept `beta2`/`next-18` and write a mutable tag into the
 * manifest. Resolving a tag means asking the registry what it currently
 * publishes, so writing the tag verbatim would commit a non-deterministic,
 * possibly-non-equivalent spec — the §4 "do not guess latest" boundary. A
 * non-concrete spec is therefore routed to the generic handoff for a concrete
 * range instead.
 */
function isConcreteVersion(version: string): boolean {
  // A range is concrete only when EVERY comparator in it is concrete; checking
  // just the first character would accept `^1.0.0 || *`, writing a mutable
  // wildcard into the manifest. An npm range is `||`-separated alternatives,
  // each a whitespace-separated list of comparators (with a lone `-` joining a
  // hyphen range, e.g. `1.2.3 - 2.3.4`). A range with no alternatives/comparators
  // (empty or `||`-only) is not concrete.
  const alternatives = version.trim().split("||");
  return alternatives.every((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((comparator) => isConcreteComparator(comparator));
  });
}

/**
 * True when a single comparator pins an actual version number. Allows a leading
 * range operator and/or `v` prefix, then requires a digit as the first version
 * character. A lone `-` is the hyphen-range separator and is permitted. Bare
 * wildcards (`*`, `x`), dist-tags (`beta2`, `next-18`), and an empty token never
 * satisfy this.
 */
function isConcreteComparator(comparator: string): boolean {
  if (comparator === "-") return true;
  return /^[v=^~<>\s]*[0-9]/.test(comparator);
}

/**
 * Split a `name@version` argument into its name and version. Scoped packages keep
 * their leading `@`, so the separator is the LAST `@` (and only when it is not the
 * scope's leading `@`). Returns `version: undefined` when no version is pinned.
 */
function splitPackageArg(arg: string): RequestedPackage {
  const at = arg.lastIndexOf("@");
  if (at <= 0) {
    // No `@`, or only the scope's leading `@` at index 0 → no version.
    return { name: arg };
  }
  const name = arg.slice(0, at);
  const version = arg.slice(at + 1);
  return version.length > 0 ? { name, version } : { name };
}

/**
 * Parse a dependency-install command into a structured request, or `undefined`
 * when the command is not a recognized dependency-install (so the caller routes
 * it to the generic Tool Request handoff). Recognized: a known package-manager
 * binary followed by an install subcommand and at least one positional package
 * argument. Flags are ignored except the dev markers.
 */
export function parseDependencyUpdateRequest(command: string): DependencyUpdateRequest | undefined {
  const tokens = parseShellTokens(command);
  if (tokens.length < 3) return undefined;
  const [bin, sub, ...rest] = tokens;

  const spec = MANAGERS.find(
    (m) => m.bins.includes(bin) && m.installSubcommands.includes(sub),
  );
  if (!spec) return undefined;

  let section: string | undefined;
  let unsupportedFlag: string | undefined;
  const packages: RequestedPackage[] = [];
  for (const tok of rest) {
    if (tok.startsWith("-")) {
      // Normalize `--flag=value` so boolean forms are matched too: npm accepts a
      // truthy `--global=true` / `--no-save=true` as the same global/no-save
      // semantics as the bare flag, which this manifest edit cannot represent.
      const eq = tok.indexOf("=");
      const flagName = eq === -1 ? tok : tok.slice(0, eq);
      const flagValue = eq === -1 ? undefined : tok.slice(eq + 1);
      const isTruthy = flagValue === undefined || !["false", "0", ""].includes(flagValue);
      // Target-changing flags carry a string target, not a boolean, so reject
      // them whenever present — a falsy-looking value is still a real target.
      if (spec.rejectTargetFlags?.includes(flagName)) {
        unsupportedFlag ??= tok;
        continue;
      }
      if (spec.rejectFlags?.includes(flagName) && isTruthy) {
        // Record the first flag the manifest edit cannot represent; the caller
        // routes the whole request to the generic handoff (`unsupported-flag`).
        unsupportedFlag ??= tok;
        continue;
      }
      // Inverse of `rejectFlags`: the falsy form is the unsupported one
      // (`--save=false` == `--no-save`). The bare/truthy form is the eligible
      // default, so only reject when an explicit falsy value is given.
      if (spec.rejectWhenFalsyFlags?.includes(flagName) && !isTruthy) {
        unsupportedFlag ??= tok;
        continue;
      }
      // Value-specific rejects (`--location=global`/`--location=user`): only the
      // listed values are unsupported; other values (`--location=project`) fall
      // through as ordinary flags.
      if (flagValue !== undefined && spec.rejectValueFlags?.[flagName]?.includes(flagValue)) {
        unsupportedFlag ??= tok;
        continue;
      }
      const mapped = isTruthy ? spec.sectionFlags?.[flagName] : undefined;
      if (mapped) section = mapped;
      // Other flags (e.g. `--save-exact`) do not change which section is written;
      // they are left to the session-pinned sync command, so ignore them here.
      continue;
    }
    packages.push(splitPackageArg(tok));
  }
  if (packages.length === 0) return undefined;
  return {
    manager: spec.manager,
    packages,
    ...(section ? { section } : {}),
    ...(unsupportedFlag ? { unsupportedFlag } : {}),
  };
}

/**
 * Attempt to satisfy a dependency-update Tool Request through the trusted,
 * handler-owned dependency-sync path. See the module header for the security
 * rationale.
 *
 * Returns `handled: false` when the request is not eligible for this path (so the
 * caller falls back to the generic Tool Request handoff), or `handled: true` with
 * `passed` indicating whether the manifest+lockfile were brought to the requested
 * state. A `handled: true, passed: false` outcome is a dependency-specific human
 * handoff (the message in `failure` explains why), never a silent pass.
 */
export function runDependencyUpdate(
  runner: CommandRunner,
  config: DependencySyncConfig | undefined,
  command: string,
  cwd: string,
  artifactDir?: string,
): DependencyUpdateResult {
  const request = parseDependencyUpdateRequest(command);
  if (!request) return { handled: false, reason: "not-a-dependency-update" };

  if (!config || !config.enabled) return { handled: false, reason: "not-configured" };

  const spec = MANAGERS.find((m) => m.manager === request.manager)!;
  // Eligible only when this build can edit the manifest AND the session's
  // dependency-sync is configured for that ecosystem's manifest. Otherwise the
  // request is for an unsupported/opted-out project type → clear handoff.
  if (!spec.applyManifest || !config.triggerPaths.includes(spec.manifest)) {
    return { handled: false, reason: "unsupported-manager" };
  }

  // A save-target/scope flag the manifest edit cannot represent (`--no-save` /
  // `--save=false`, `--global` / `--location=global`), or a target-changing flag
  // that redirects the save to another
  // workspace/prefix manifest (`--workspace`/`-w`/`--prefix`/`-C`), must NOT be
  // applied as an ordinary entry in the root manifest — that would silently
  // change the requested semantics or target the wrong package. Hand off instead.
  if (request.unsupportedFlag) {
    return { handled: false, reason: "unsupported-flag" };
  }

  // The trusted path pins a concrete version into the manifest. Without one we
  // cannot deterministically resolve "latest" without running the unsafe install,
  // so hand off rather than guess.
  if (request.packages.some((p) => !p.version)) {
    return { handled: false, reason: "missing-version" };
  }

  // A pinned-but-mutable spec — an npm dist-tag (`foo@latest`, `foo@beta`) or an
  // unbounded wildcard (`foo@*`) — is NOT deterministic: the manifest editor would
  // write the tag verbatim and the registry could resolve it to anything later.
  // Hand off for a concrete semver rather than committing a guessed/mutable spec.
  if (request.packages.some((p) => !isConcreteVersion(p.version!))) {
    return { handled: false, reason: "non-concrete-version" };
  }

  const manifestPath = spec.manifest;
  const edit = spec.applyManifest(join(cwd, manifestPath), request.packages, request.section);
  if (!edit.ok) {
    return {
      handled: true,
      passed: false,
      manager: request.manager,
      manifestPath,
      packages: [],
      failure: { kind: "manifest-error", message: edit.error },
    };
  }

  // Regenerate the lockfile with the EXACT, session-pinned command (in safe
  // lockfile-only mode unless the session opted into lifecycle scripts).
  // runDependencySync runs that command only when a trigger path (the manifest)
  // is actually dirty, which lets one call cover both manifest states uniformly:
  //   - the edit above just made the manifest dirty (the normal case); or
  //   - the agent had ALREADY edited package.json to the requested version before
  //     emitting the install request, so applyManifest wrote nothing
  //     (`edit.applied` is empty) but the manifest is still dirty and the lockfile
  //     is stale. Classifying that as `unchanged` here (the old behavior) would
  //     hand off and discard the agent's valid manifest edit, never regenerating
  //     the lockfile — so let the sync run for it instead (issue #302 review).
  const sync = runDependencySync(runner, config, cwd, artifactDir);

  if (edit.applied.length === 0 && sync.ran === false && sync.passed) {
    // Genuinely already satisfied: the manifest pins every requested version AND
    // no trigger path is dirty, so the sync was a no-op and there is nothing to
    // regenerate. Surfacing this (instead of committing nothing) is the whole
    // point of issue #302: it stops the agent re-requesting an install that never
    // changes package state.
    const names = request.packages
      .map((p) => `${p.name}@${p.version}`)
      .join(", ");
    return {
      handled: true,
      passed: false,
      manager: request.manager,
      manifestPath,
      packages: [],
      failure: {
        kind: "unchanged",
        message:
          `Requested ${manifestPath} dependency state is already satisfied (${names} already pinned); ` +
          `no dependency sync was needed. The agent does not need this command — it can proceed without it.`,
      },
    };
  }

  if (!sync.passed) {
    const failureOutput = sync.failure
      ? boundVerificationOutput(sync.failure.output)
      : "dependency sync did not run";
    return {
      handled: true,
      passed: false,
      manager: request.manager,
      manifestPath,
      packages: edit.applied,
      sync,
      failure: { kind: "sync-failed", message: failureOutput },
    };
  }

  return {
    handled: true,
    passed: true,
    manager: request.manager,
    manifestPath,
    packages: edit.applied,
    sync,
  };
}
