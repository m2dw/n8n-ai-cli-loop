/**
 * The read-only isolation and local-artifact primitives shared by the
 * review-dispute protocol's no-tool agent turns (issues #838, #846).
 *
 * §8.2 of docs/review-dispute-contract.md states the posture once — "the agent
 * is invoked with no tool permissions, and the bundle is the entire input" — and
 * both the reviewer's reconsideration and the arbiter's arbitration are held to
 * it. The mechanics of that posture are what live here: a throwaway cwd, an
 * isolated home/config, an environment stripped of every credential that could
 * authenticate a mutation, and artifact reads/writes that refuse to follow a
 * symlink out of the run's own directory.
 *
 * Extracted rather than copied because two copies of a security boundary drift
 * into two different boundaries: a fix applied to one — the `O_NOFOLLOW` on the
 * artifact open, the UTF-8-boundary-aware truncation, the `mkdtemp` failure that
 * must not leak its sibling — would otherwise silently not apply to the other.
 * The behavior is #838's, unchanged; the only generalizations are the temp-dir
 * name prefix and the provider whose authentication survives the strip, both of
 * which #838 previously hard-coded because it had exactly one caller.
 *
 * Nothing here decides WHAT an agent is shown or WHETHER its answer is admitted.
 * Those belong to the prompt and response modules of each turn.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// The stripped environment
// ---------------------------------------------------------------------------

/**
 * Env vars that grant GitHub write (or elevated) access via the gh CLI or an
 * Actions runtime.
 *
 * Same boundary `src/cli/issue-discuss.ts` establishes for its own agent step;
 * restated here because handlers never import from `src/cli` (that direction is
 * reserved: the CLI imports handlers). The list exists for one reason — an agent
 * processing untrusted text must not be able to authenticate a write.
 */
export const WRITE_ENABLING_ENV_KEYS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_APP_ID",
  "GH_INSTALLATION_TOKEN",
  "GITHUB_APP_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];

/** Vars that leak the caller's checkout path, so the agent cannot `cd` back into it. */
export const CWD_BEARING_ENV_KEYS: readonly string[] = [
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "npm_config_local_prefix",
  "npm_package_json",
];

/**
 * The provider credentials a selected CLI still needs to authenticate ITSELF,
 * keyed by the provider string every resolved profile in this codebase records
 * (`providerForAgent`).
 *
 * Only the selected provider's entry is restored, which is what makes "strip
 * mutation credentials, preserve provider authentication" checkable rather than
 * merely stated: an arbiter resolved to one provider never carries another
 * provider's key, and no entry here can authenticate a repository or GitHub
 * mutation.
 */
const PROVIDER_AUTH_PASSTHROUGH_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"],
};

/**
 * The config-dir var a provider's CLI reads, pointed back at the REAL home.
 *
 * The throwaway `HOME` below hides a HOME-backed CLI login, so the one directory
 * holding the selected provider's own credentials is named explicitly while
 * `GH_CONFIG_DIR` stays pinned to the empty temp dir — GitHub credentials remain
 * unreachable either way.
 */
const PROVIDER_CONFIG_DIR_KEYS: Readonly<Record<string, string>> = {
  anthropic: "CLAUDE_CONFIG_DIR",
  openai: "CODEX_HOME",
};

/**
 * Own-property lookup over the two provider tables.
 *
 * The provider string comes from a resolved profile rather than from a literal,
 * so `constructor` or `toString` reaches an inherited `Object.prototype` member
 * on a plain index — which would hand a function to the `for…of` below instead of
 * a key list. An unknown provider must mean "no credential survives the strip",
 * never "throw" and never "inherit something".
 */
function providerEntry<T>(table: Readonly<Record<string, T>>, provider: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, provider) ? table[provider] : undefined;
}

/**
 * Every provider credential and config-dir var named by the two tables above,
 * regardless of provider.
 *
 * The strip removes all of them and the selected provider's entries are then put
 * back, rather than the selected provider's simply being left in place: an
 * inherited environment carries whatever the operator happens to have exported,
 * so "only the selected provider's credentials survive" has to be enforced by
 * removing the others, not by declining to add them. An unknown provider then
 * carries no provider credential at all, which is the same answer
 * {@link providerEntry} gives for it.
 */
const ALL_PROVIDER_ENV_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(PROVIDER_AUTH_PASSTHROUGH_KEYS).flatMap((keys) => [...keys]),
    ...Object.values(PROVIDER_CONFIG_DIR_KEYS),
  ]),
];

export interface IsolatedInvocationEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Directories to remove once the agent has exited, in any outcome. */
  cleanup: string[];
}

export interface IsolatedInvocationOptions {
  /**
   * Temp-directory name prefix, so an operator inspecting `TMPDIR` mid-run can
   * tell which turn a sandbox belongs to.
   */
  prefix: string;
  /** The RESOLVED profile's provider. Only its credentials survive the strip. */
  provider: string;
}

/**
 * Build the isolated environment and throwaway cwd for one no-tool agent run.
 *
 * The two temp directories are the caller's to remove: they are returned in
 * `cleanup` rather than removed here, because the agent has not run yet when
 * this returns.
 */
export function buildIsolatedInvocation(
  source: NodeJS.ProcessEnv,
  options: IsolatedInvocationOptions,
): IsolatedInvocationEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of WRITE_ENABLING_ENV_KEYS) delete env[key];
  for (const key of CWD_BEARING_ENV_KEYS) delete env[key];
  for (const key of ALL_PROVIDER_ENV_KEYS) delete env[key];
  const home = mkdtempSync(join(tmpdir(), `${options.prefix}-home-`));
  let cwd: string;
  try {
    cwd = mkdtempSync(join(tmpdir(), `${options.prefix}-cwd-`));
  } catch (err) {
    // The second directory is the one that failed, so the caller's `cleanup`
    // never sees the first: whatever made this throw (a full or unwritable
    // TMPDIR) is exactly the condition under which a leaked directory is least
    // affordable, so it is removed here rather than left behind.
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Nothing better to do: the setup failure below is the reportable fact.
    }
    throw err;
  }
  env["HOME"] = home;
  env["GH_CONFIG_DIR"] = home;
  delete env["XDG_CONFIG_HOME"];
  // Pin PWD to the sandbox so the agent's reported cwd matches its actual one.
  env["PWD"] = cwd;
  const configDirKey = providerEntry(PROVIDER_CONFIG_DIR_KEYS, options.provider);
  if (configDirKey !== undefined) {
    if (source[configDirKey]) {
      env[configDirKey] = source[configDirKey];
    } else if (source["HOME"]) {
      env[configDirKey] = source["HOME"];
    }
  }
  for (const key of providerEntry(PROVIDER_AUTH_PASSTHROUGH_KEYS, options.provider) ?? []) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { env, cwd, cleanup: [home, cwd] };
}

// ---------------------------------------------------------------------------
// Bounded local artifacts
// ---------------------------------------------------------------------------

/**
 * Bound one agent stream for local capture.
 *
 * Cut on BYTES, not characters: the bound exists to keep one runaway agent from
 * filling the artifact directory, and a character slice of non-ASCII output can
 * be three times the size it claims to be. Output within the bound is returned
 * untouched — the truncation marker is the only content a runner ever adds to a
 * transcript, and it appears only where bytes were actually dropped.
 *
 * The cut itself is pulled back to a UTF-8 character boundary. Decoding a slice
 * that ends mid-sequence would have `Buffer#toString` substitute U+FFFD for the
 * partial character, which is runner-authored content the marker does not cover
 * and which silently rewrites the agent's own bytes; dropping the incomplete
 * trailing character instead keeps everything before the marker verbatim.
 */
export function boundRawOutput(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  // Continuation bytes are 0b10xxxxxx; a lead or ASCII byte starts a character.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return `${bytes.subarray(0, cut).toString("utf8")}\n--- truncated at ${maxBytes} bytes ---`;
}

/** Thrown by {@link writeArtifactFile}; distinguished from an ordinary IO failure. */
export class UnsafeArtifactPathError extends Error {}

/**
 * `open(2)` flags for an artifact write: create or truncate, and — where the
 * platform defines it — refuse a final component that is a symlink. Windows has
 * no `O_NOFOLLOW`, so the constant is read defensively and the `lstat` check
 * below carries the guarantee alone there.
 */
const ARTIFACT_WRITE_FLAG =
  fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_TRUNC
  | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);

/**
 * `open(2)` flags for an artifact READ, the mirror of {@link ARTIFACT_WRITE_FLAG}.
 *
 * `O_NOFOLLOW` refuses a final component that is a symlink, so an artifact
 * planted as a link to a file outside the run's directory is never opened — and
 * because the refusal happens in the open itself, no check performed beforehand
 * can be raced past. `O_NONBLOCK` is what makes a planted FIFO safe to classify:
 * opening one read-only otherwise blocks until a writer connects, which would
 * hang the phase and the issue lock it holds; with the flag the open returns and
 * the descriptor's `fstat` rejects it as not a regular file. Neither flag has any
 * effect on the regular-file reads this is for. The constants are read
 * defensively — Windows defines none of them.
 */
const ARTIFACT_READ_FLAGS =
  fsConstants.O_RDONLY
  | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
  | (typeof fsConstants.O_NOCTTY === "number" ? fsConstants.O_NOCTTY : 0)
  | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

/**
 * Write one artifact, refusing to write THROUGH a symlink.
 *
 * `isSafeArtifactDirAfterRun` answers a question about the DIRECTORY, and a
 * directory that passes it can still hold a leaf entry that is a link to an
 * arbitrary writable file elsewhere: every name these turns write is derived
 * from the lineage id, so it is predictable enough to plant one at — a retry of
 * the same pending turn writes exactly the names its first attempt did. Plain
 * `writeFileSync` follows a link at the final component like any other open, and
 * the escape needs no privilege beyond a local actor who can create a file in the
 * run's own directory.
 *
 * Both halves of the guard are deliberate: `lstat` refuses a planted link as the
 * refusal it is (`ENOENT` means the leaf is absent, which is the ordinary case
 * and safe to create), and `O_NOFOLLOW` closes the window between that check and
 * the open, where a link could be swapped in. Throws — every call site already
 * sits inside the try/catch that turns a failed artifact write into a typed
 * outcome.
 */
export function writeArtifactFile(dir: string, name: string, content: string): void {
  const path = join(dir, name);
  let leaf: ReturnType<typeof lstatSync> | undefined;
  try {
    leaf = lstatSync(path);
  } catch {
    // Absent (or unreadable): nothing to follow. A path that cannot be created
    // fails in the write below, as its own IO error.
    leaf = undefined;
  }
  if (leaf?.isSymbolicLink()) throw new UnsafeArtifactPathError(name);
  // `openSync` rather than a plain `writeFileSync(path, ...)`: only the open
  // takes the flags, and `O_NOFOLLOW` is the half of the guard that no check
  // performed beforehand can provide.
  const fd = openSync(path, ARTIFACT_WRITE_FLAG, 0o666);
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export type BoundedArtifactRead =
  | { ok: true; raw: string }
  /** `missing` covers absent, unreadable, symlinked, and not-a-regular-file alike. */
  | { ok: false; reason: "missing" | "too-large"; detail: string };

/**
 * Read one §10.2 artifact under a byte bound applied to the FILE, before any of
 * it is in memory.
 *
 * These artifacts are local files that sit between two runs, so a corrupted or
 * replaced one can be arbitrarily large — and reading it whole to hand to
 * `JSON.parse` would exhaust the worker on exactly the input that should have
 * failed closed as a malformed bounded record.
 *
 * The read goes through a descriptor opened with {@link ARTIFACT_READ_FLAGS}
 * rather than through the path, for the reason {@link writeArtifactFile} opens
 * its own: `isSafeArtifactDirAfterRun` answers a question about the DIRECTORY,
 * and these leaf names are derived from the lineage id, so a local actor who can
 * create a file in the run's directory can plant one. A symlinked artifact would
 * otherwise be stat'd and read as an ordinary bounded record, and its contents —
 * a file from anywhere the runner can read — would reach the agent's prompt.
 * Classifying the OPEN descriptor also closes the window in which the path could
 * become a FIFO after a path-based `stat` said it was a regular file.
 */
export function readBoundedArtifact(path: string, maxBytes: number): BoundedArtifactRead {
  let fd: number;
  try {
    fd = openSync(path, ARTIFACT_READ_FLAGS);
  } catch {
    // Absent, unreadable — or `O_NOFOLLOW`'s own refusal (ELOOP, EMLINK on some
    // BSDs) of a leaf that is a symlink. All three are "there is no artifact
    // here to read", which is what `missing` means to every caller.
    return { ok: false, reason: "missing", detail: "unreadable" };
  }
  try {
    // `fstat` on the OPEN descriptor, not `stat` on the path: what is classified
    // and what is read are then the same object, with no window between them for
    // the name to be repointed. `isFile()` refuses a FIFO or a character device,
    // whose reported size says nothing about how much a read would deliver.
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "missing", detail: "not-a-file" };
    if (stat.size > maxBytes) return { ok: false, reason: "too-large", detail: `too-large:${stat.size}` };
    // One byte past the bound is all this ever holds: a file that GREW between
    // the fstat and the read is refused on what actually arrived rather than
    // parsed on the stale answer, and the overrun costs one byte, not a file.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    if (filled > maxBytes) return { ok: false, reason: "too-large", detail: `too-large:${filled}` };
    return { ok: true, raw: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { ok: false, reason: "missing", detail: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The locator for an agent that threw instead of running.
 *
 * A failure detail is content-free by contract — it travels into a task's public
 * summary — and an error's `message` is not: a failed `mkdtemp` puts the TMPDIR
 * path in its text. Only an errno-shaped `code` is carried through, and only when
 * it looks like one (`ENOSPC`, `EACCES`); anything else is dropped for the bare
 * `spawn`, which still says the run never reached an agent.
 */
export function agentSetupDetail(err: unknown): string {
  const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9]{1,15}$/.test(code) ? `spawn:${code}` : "spawn";
}
