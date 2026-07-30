import { jest } from '@jest/globals';
import {
  DEFAULT_CACHE_DIR,
  cachedJarPath,
  ensureCachedJar,
  sanitizeReleaseForFilename,
} from '../scripts/copybara-jar-cache.mjs';
import { sha256File } from '../scripts/copybara-export.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

let tmpDir;
let cacheDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'copybara-jar-cache-test-'));
  cacheDir = join(tmpDir, 'cache');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sanitizeReleaseForFilename', () => {
  test('replaces unsafe characters', () => {
    expect(sanitizeReleaseForFilename('v1/2 (beta)')).toBe('v1_2__beta_');
  });
});

describe('cachedJarPath', () => {
  test('is deterministic for a given release', () => {
    const pin = { release: 'v1.2.3' };
    expect(cachedJarPath(pin, cacheDir)).toBe(join(cacheDir, 'copybara-v1.2.3.jar'));
  });
});

describe('DEFAULT_CACHE_DIR', () => {
  test('lives outside any repository-tracked path (under the home cache dir)', () => {
    expect(DEFAULT_CACHE_DIR).toMatch(/\.cache[\\/]n8n-ai-cli-loop[\\/]copybara$/);
  });
});

describe('ensureCachedJar', () => {
  test('fails closed on an unpopulated pin', async () => {
    const result = await ensureCachedJar({ pin: { release: null, jarSha256: null }, cacheDir });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('pin');
  });

  test('returns the existing cached jar when its checksum already matches', async () => {
    mkdirSync(cacheDir, { recursive: true });
    const jarBytes = 'already-cached-bytes';
    const pin = { release: 'v1', jarSha256: createHash('sha256').update(jarBytes).digest('hex') };
    const target = cachedJarPath(pin, cacheDir);
    writeFileSync(target, jarBytes);

    const download = jest.fn();
    const result = await ensureCachedJar({ pin, cacheDir, download });
    expect(result).toEqual({ ok: true, jarPath: target, cached: true });
    expect(download).not.toHaveBeenCalled();
  });

  test('fails closed when there is no cached jar and the pin has no downloadUrl', async () => {
    const pin = { release: 'v1', jarSha256: 'deadbeef' };
    const result = await ensureCachedJar({ pin, cacheDir });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('download');
    expect(result.reason).toMatch(/downloadUrl/);
  });

  test('downloads and caches the jar when the checksum matches', async () => {
    const jarBytes = 'freshly-downloaded-bytes';
    const expected = createHash('sha256').update(jarBytes).digest('hex');
    const pin = { release: 'v2', jarSha256: expected, downloadUrl: 'https://example.invalid/copybara.jar' };

    const download = jest.fn(async (url, destPath) => {
      expect(url).toBe(pin.downloadUrl);
      writeFileSync(destPath, jarBytes);
    });

    const result = await ensureCachedJar({ pin, cacheDir, download });
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(false);
    expect(sha256File(result.jarPath)).toBe(expected);
    // No leftover .download-* temp files.
    expect(readdirSync(cacheDir).filter((f) => f.startsWith('.download-'))).toEqual([]);
  });

  test('fails closed and removes the temp file on a checksum mismatch', async () => {
    const pin = { release: 'v3', jarSha256: 'deadbeef', downloadUrl: 'https://example.invalid/copybara.jar' };
    const download = jest.fn(async (url, destPath) => {
      writeFileSync(destPath, 'not-the-right-bytes');
    });

    const result = await ensureCachedJar({ pin, cacheDir, download });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('checksum');
    expect(existsSync(cachedJarPath(pin, cacheDir))).toBe(false);
    expect(readdirSync(cacheDir).filter((f) => f.startsWith('.download-'))).toEqual([]);
  });

  test('re-downloads a stale cache entry whose checksum no longer matches the pin', async () => {
    mkdirSync(cacheDir, { recursive: true });
    const pin = { release: 'v4', jarSha256: null, downloadUrl: 'https://example.invalid/copybara.jar' };
    const staleTarget = join(cacheDir, 'copybara-v4.jar');
    writeFileSync(staleTarget, 'stale-bytes-from-an-old-pin');

    const freshBytes = 'rolled-forward-pin-bytes';
    const freshSha = createHash('sha256').update(freshBytes).digest('hex');
    pin.jarSha256 = freshSha;
    const download = jest.fn(async (url, destPath) => writeFileSync(destPath, freshBytes));

    const result = await ensureCachedJar({ pin, cacheDir, download });
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(false);
    expect(sha256File(result.jarPath)).toBe(freshSha);
  });

  test('surfaces a download failure as ok:false without leaving a temp file', async () => {
    const pin = { release: 'v5', jarSha256: 'deadbeef', downloadUrl: 'https://example.invalid/copybara.jar' };
    const download = jest.fn(async () => {
      throw new Error('network unreachable');
    });

    const result = await ensureCachedJar({ pin, cacheDir, download });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('download');
    expect(result.reason).toMatch(/network unreachable/);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.startsWith('.download-')) : []).toEqual([]);
  });
});
