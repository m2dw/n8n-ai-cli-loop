/**
 * copybara-jar-cache.mjs
 *
 * Explicit, operator-triggered download/cache of the pinned Copybara
 * uberjar declared in copybara/PIN.json. This module is only ever invoked
 * from scripts/public-export.mjs when an operator runs `npm run
 * public:export` / `npm run public:publish` — it never runs during `npm
 * install`, and the downloaded jar is never committed to this repository:
 * it is cached outside the repo tree by default (see DEFAULT_CACHE_DIR).
 *
 * See docs/copybara-public-export.md for the cache location, the pin
 * bootstrap procedure, and failure recovery.
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { sha256File } from './copybara-export.mjs';

export const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'n8n-ai-cli-loop', 'copybara');

/** Sanitize a pin release identifier into a safe, predictable cache filename. */
export function sanitizeReleaseForFilename(release) {
  return String(release).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function cachedJarPath(pin, cacheDir = DEFAULT_CACHE_DIR) {
  return join(cacheDir, `copybara-${sanitizeReleaseForFilename(pin.release)}.jar`);
}

/** Default downloader: fetch the pinned URL and write the body to destPath. */
export async function defaultDownload(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
}

/**
 * Ensure the pinned jar is present and checksum-valid in the cache,
 * downloading it if necessary. Fails closed at every step: an unpopulated
 * pin, a missing "downloadUrl" when a download is actually needed, or a
 * checksum mismatch (a stale cache entry OR a freshly downloaded file) all
 * return ok:false rather than silently trusting or discarding an
 * unverifiable jar. A stale cache entry (checksum no longer matches the
 * pin, e.g. after the pin was rolled to a new release) is removed rather
 * than reused, so a rerun re-downloads instead of running a jar the pin no
 * longer trusts.
 */
export async function ensureCachedJar({ pin, cacheDir = DEFAULT_CACHE_DIR, download = defaultDownload }) {
  if (!pin.release || !pin.jarSha256) {
    return { ok: false, stage: 'pin', reason: 'copybara pin is not populated yet — run the pin bootstrap in docs/copybara-export-poc.md#pinning' };
  }
  const target = cachedJarPath(pin, cacheDir);

  if (existsSync(target)) {
    if (sha256File(target) === pin.jarSha256) {
      return { ok: true, jarPath: target, cached: true };
    }
    rmSync(target, { force: true });
  }

  if (!pin.downloadUrl) {
    return {
      ok: false,
      stage: 'download',
      reason: `no cached jar at ${target} and copybara/PIN.json has no "downloadUrl" — download the pinned release manually and pass --jar <path>`,
    };
  }

  mkdirSync(cacheDir, { recursive: true });
  const tempPath = join(cacheDir, `.download-${randomBytes(8).toString('hex')}`);
  try {
    await download(pin.downloadUrl, tempPath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    return { ok: false, stage: 'download', reason: `jar download failed: ${err && err.message ? err.message : err}` };
  }

  const actual = sha256File(tempPath);
  if (actual !== pin.jarSha256) {
    rmSync(tempPath, { force: true });
    return { ok: false, stage: 'checksum', reason: `downloaded jar checksum mismatch: expected ${pin.jarSha256}, got ${actual}` };
  }
  renameSync(tempPath, target);
  return { ok: true, jarPath: target, cached: false };
}
