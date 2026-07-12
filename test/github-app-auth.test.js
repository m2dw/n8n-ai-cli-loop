import { generateKeyPairSync, createVerify } from 'crypto';
import {
  GitHubAppAuth,
  createAppJwt,
  createGhRunnerForAuth,
  ghRunnerWithToken,
  resolveGhRunner,
  resolveGitHubAppCredentials,
  redactSecrets,
  GitHubAuthConfigError,
} from '../dist/index.js';

// A 2048-bit RSA keypair shared by the JWT/signature tests.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

// A mocked HTTP transport: records each request and returns a queued response.
function mockHttp(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[i] ?? { status: 500, statusText: 'unexpected', body: '' };
    i++;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const TOKEN_OK = (token, expiresAt) => ({
  status: 201,
  statusText: 'Created',
  body: JSON.stringify({ token, expires_at: expiresAt }),
});

// A mocked synchronous HTTP transport (used by the expired-token refresh path).
function mockHttpSync(responses) {
  const calls = [];
  let i = 0;
  const fn = (url, opts) => {
    calls.push({ url, opts });
    const r = responses[i] ?? { status: 500, statusText: 'unexpected', body: '' };
    i++;
    return r;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// createAppJwt
// ---------------------------------------------------------------------------

describe('createAppJwt', () => {
  const FIXED_MS = 1_700_000_000_000; // fixed clock
  const nowSec = Math.floor(FIXED_MS / 1000);

  test('produces a verifiable RS256 JWT with iss/iat/exp from the injected clock', () => {
    const jwt = createAppJwt({ appId: '123456', privateKey, now: () => FIXED_MS });
    const [headerSeg, payloadSeg, sigSeg] = jwt.split('.');

    expect(decodeSegment(headerSeg)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = decodeSegment(payloadSeg);
    expect(payload.iss).toBe('123456');
    expect(payload.iat).toBe(nowSec - 60); // backdated for clock skew
    expect(payload.exp).toBe(nowSec + 600); // 10-minute lifetime

    // Signature verifies against the public key over header.payload.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    const sig = Buffer.from(sigSeg, 'base64url');
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  test('defaults to Date.now when no clock is injected', () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = createAppJwt({ appId: '1', privateKey });
    const payload = decodeSegment(jwt.split('.')[1]);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60 - 2);
  });

  test('a malformed private key raises a permanent config error, not a transient one', () => {
    const badKey = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';
    let thrown;
    try {
      createAppJwt({ appId: '1', privateKey: badKey });
    } catch (e) {
      thrown = e;
    }
    // Must be a GitHubAuthConfigError so the outbox dispatcher treats it as a
    // setup error (exit 1) rather than a retryable dispatch failure.
    expect(thrown).toBeInstanceOf(GitHubAuthConfigError);
    // The (unusable) key must not leak into the error message.
    expect(thrown.message).not.toContain('not-a-real-key');
  });
});

// ---------------------------------------------------------------------------
// GitHubAppAuth — installation token exchange
// ---------------------------------------------------------------------------

describe('GitHubAppAuth.getInstallationToken — exchange', () => {
  test('POSTs the JWT to the installation endpoint and returns the token', async () => {
    const http = mockHttp([TOKEN_OK('ghs_installationtokenvalue000000000000', '2030-01-01T00:00:00Z')]);
    const auth = new GitHubAppAuth({
      appId: '123456',
      installationId: '78901234',
      privateKey,
      httpPostJson: http,
      now: () => 1_700_000_000_000,
    });

    const token = await auth.getInstallationToken();

    expect(token).toBe('ghs_installationtokenvalue000000000000');
    expect(http.calls).toHaveLength(1);
    const { url, opts } = http.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/78901234/access_tokens');
    expect(opts.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/);
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
  });

  test('honors a custom apiBaseUrl', async () => {
    const http = mockHttp([TOKEN_OK('ghs_x000000000000000000000000', '2030-01-01T00:00:00Z')]);
    const auth = new GitHubAppAuth({
      appId: '1',
      installationId: '2',
      privateKey,
      httpPostJson: http,
      apiBaseUrl: 'https://ghe.example.com/api/v3/',
    });
    await auth.getInstallationToken();
    expect(http.calls[0].url).toBe('https://ghe.example.com/api/v3/app/installations/2/access_tokens');
  });

  test('throws on a missing token in the response', async () => {
    const http = mockHttp([{ status: 201, statusText: 'Created', body: JSON.stringify({ expires_at: '2030-01-01T00:00:00Z' }) }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    await expect(auth.getInstallationToken()).rejects.toThrow(/did not include a token/);
  });

  test('throws on non-JSON response', async () => {
    const http = mockHttp([{ status: 201, statusText: 'Created', body: 'not json' }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    await expect(auth.getInstallationToken()).rejects.toThrow(/not valid JSON/);
  });

  // A 4xx means the credentials are wrong (bad App id / installation id / key not
  // authorized): permanent. A 5xx (or a 429 rate-limit) is transient and should
  // stay retryable. The outbox dispatcher relies on this distinction.
  test.each([401, 403, 404])('classifies HTTP %i as a permanent config error', async (status) => {
    const http = mockHttp([{ status, statusText: 'Err', body: '{"message":"nope"}' }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown).toBeInstanceOf(GitHubAuthConfigError);
    expect(thrown.message).toMatch(new RegExp(`HTTP ${status}`));
  });

  test.each([429, 500, 502, 503])('classifies HTTP %i as a transient (non-config) error', async (status) => {
    const http = mockHttp([{ status, statusText: 'Err', body: '{"message":"later"}' }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(GitHubAuthConfigError);
    expect(thrown.message).toMatch(new RegExp(`HTTP ${status}`));
  });

  // GitHub returns HTTP 403 for rate limits as well as 429, so a rate-limited 403
  // must stay transient (retryable) rather than becoming a fatal config error —
  // otherwise the outbox dispatcher exits 1 on a passing throttle.
  test.each([
    'API rate limit exceeded for installation ID 2.',
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  ])('classifies a rate-limited 403 (%s) as transient', async (message) => {
    const http = mockHttp([{ status: 403, statusText: 'Forbidden', body: JSON.stringify({ message }) }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(GitHubAuthConfigError);
    expect(thrown.message).toMatch(/HTTP 403/);
  });

  test('still classifies a non-rate-limit 403 as a permanent config error', async () => {
    const http = mockHttp([{ status: 403, statusText: 'Forbidden', body: '{"message":"Resource not accessible by integration"}' }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown).toBeInstanceOf(GitHubAuthConfigError);
  });
});

// ---------------------------------------------------------------------------
// GitHubAppAuth — caching / refresh
// ---------------------------------------------------------------------------

describe('GitHubAppAuth.getInstallationToken — caching/refresh', () => {
  test('caches the token across calls until near expiry', async () => {
    let clock = 1_700_000_000_000;
    const expiresAt = new Date(clock + 3600_000).toISOString(); // +1h
    const http = mockHttp([TOKEN_OK('ghs_first0000000000000000000000', expiresAt)]);
    const auth = new GitHubAppAuth({
      appId: '1',
      installationId: '2',
      privateKey,
      httpPostJson: http,
      now: () => clock,
    });

    expect(await auth.getInstallationToken()).toBe('ghs_first0000000000000000000000');
    clock += 1000; // well within validity
    expect(await auth.getInstallationToken()).toBe('ghs_first0000000000000000000000');
    expect(http.calls).toHaveLength(1); // served from cache
  });

  test('refreshes once the cached token is within the skew window of expiry', async () => {
    let clock = 1_700_000_000_000;
    const expiresAt = new Date(clock + 120_000).toISOString(); // +2 min
    const http = mockHttp([
      TOKEN_OK('ghs_first0000000000000000000000', expiresAt),
      TOKEN_OK('ghs_second000000000000000000000', new Date(clock + 3_600_000).toISOString()),
    ]);
    const auth = new GitHubAppAuth({
      appId: '1',
      installationId: '2',
      privateKey,
      httpPostJson: http,
      now: () => clock,
      refreshSkewMs: 60_000,
    });

    expect(await auth.getInstallationToken()).toBe('ghs_first0000000000000000000000');
    clock += 90_000; // now within 60s skew of the +120s expiry
    expect(await auth.getInstallationToken()).toBe('ghs_second000000000000000000000');
    expect(http.calls).toHaveLength(2);
  });

  test('does not cache indefinitely when expires_at is missing', async () => {
    let clock = 1_700_000_000_000;
    const http = mockHttp([
      { status: 201, statusText: 'Created', body: JSON.stringify({ token: 'ghs_a00000000000000000000000' }) },
      TOKEN_OK('ghs_b00000000000000000000000', new Date(clock + 3_600_000).toISOString()),
    ]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http, now: () => clock });
    expect(await auth.getInstallationToken()).toBe('ghs_a00000000000000000000000');
    clock += 1; // past the skew boundary the missing-expiry path set
    expect(await auth.getInstallationToken()).toBe('ghs_b00000000000000000000000');
    expect(http.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GitHubAppAuth.getCachedToken — synchronous accessor used by the gh runner
// ---------------------------------------------------------------------------

describe('GitHubAppAuth.getCachedToken', () => {
  test('throws before the cache has been warmed', () => {
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: mockHttp([]) });
    expect(() => auth.getCachedToken()).toThrow(/has not been resolved yet/);
  });

  test('serves the cached token within validity without re-exchanging', async () => {
    let clock = 1_700_000_000_000;
    const http = mockHttp([TOKEN_OK('ghs_only00000000000000000000000', new Date(clock + 3_600_000).toISOString())]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http, now: () => clock });
    await auth.getInstallationToken();
    expect(auth.getCachedToken()).toBe('ghs_only00000000000000000000000');
    expect(auth.getCachedToken()).toBe('ghs_only00000000000000000000000');
    expect(http.calls).toHaveLength(1);
  });

  test('serves the still-valid token but refreshes in the background once within the skew window', async () => {
    let clock = 1_700_000_000_000;
    const http = mockHttp([
      TOKEN_OK('ghs_first0000000000000000000000', new Date(clock + 120_000).toISOString()), // +2min
      TOKEN_OK('ghs_second000000000000000000000', new Date(clock + 3_600_000).toISOString()),
    ]);
    const auth = new GitHubAppAuth({
      appId: '1', installationId: '2', privateKey, httpPostJson: http, now: () => clock, refreshSkewMs: 60_000,
    });
    await auth.getInstallationToken();

    clock += 90_000; // now within 60s skew of the +120s expiry
    // The synchronous accessor returns the still-valid token immediately...
    expect(auth.getCachedToken()).toBe('ghs_first0000000000000000000000');
    // ...and kicks off a single background refresh.
    await new Promise((resolve) => setImmediate(resolve));
    expect(http.calls).toHaveLength(2);
    // Subsequent reads serve the refreshed token (no stale token past expiry).
    expect(auth.getCachedToken()).toBe('ghs_second000000000000000000000');
  });

  test('refreshes synchronously and never serves a token that has already expired', async () => {
    let clock = 1_700_000_000_000;
    const http = mockHttp([
      TOKEN_OK('ghs_first0000000000000000000000', new Date(clock + 120_000).toISOString()), // +2min
    ]);
    // A fresh token is only obtainable via the synchronous transport here.
    const httpSync = mockHttpSync([
      TOKEN_OK('ghs_refreshed00000000000000000', new Date(clock + 3_600_000).toISOString()),
    ]);
    const auth = new GitHubAppAuth({
      appId: '1', installationId: '2', privateKey,
      httpPostJson: http, httpPostJsonSync: httpSync, now: () => clock, refreshSkewMs: 60_000,
    });
    await auth.getInstallationToken();

    // Jump past actual expiry (process was busy/idle for >2min with no gh call).
    clock += 200_000;
    // The accessor must NOT hand back the dead token: it refreshes synchronously
    // (no await) and returns the fresh one, so the next `gh` spawn has a live token.
    expect(auth.getCachedToken()).toBe('ghs_refreshed00000000000000000');
    expect(httpSync.calls).toHaveLength(1);
    // The async background path was never used for this expired refresh.
    expect(http.calls).toHaveLength(1);
    // And the now-valid token is served from cache without re-exchanging.
    expect(auth.getCachedToken()).toBe('ghs_refreshed00000000000000000');
    expect(httpSync.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveGhRunner — runtime wiring seam
// ---------------------------------------------------------------------------

describe('resolveGhRunner', () => {
  test('gh mode returns the fallback runner unchanged (no token exchange)', async () => {
    const http = mockHttp([]);
    const fallback = { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    const got = await resolveGhRunner({ mode: 'gh' }, fallback, { httpPostJson: http });
    expect(got).toBe(fallback);
    expect(http.calls).toHaveLength(0);
  });

  test('github-app mode resolves credentials and returns a distinct token runner', async () => {
    const http = mockHttp([TOKEN_OK('ghs_resolved00000000000000000000', '2030-01-01T00:00:00Z')]);
    const fallback = { run: () => ({ exitCode: 1, stdout: '', stderr: '' }) };
    const got = await resolveGhRunner(
      { mode: 'github-app', appIdEnv: 'A', installationIdEnv: 'I', privateKeyPathEnv: 'K' },
      fallback,
      { env: { A: '1', I: '2', K: '/k.pem' }, readFile: () => privateKey, httpPostJson: http },
    );
    expect(got).not.toBe(fallback);
    expect(typeof got.run).toBe('function');
    expect(http.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Redaction / no token leakage in errors
// ---------------------------------------------------------------------------

describe('redaction / no token leakage', () => {
  test('redactSecrets removes provided secrets and GitHub token patterns', () => {
    const out = redactSecrets('jwt=abcd1234 token=ghs_abcdefghijklmnopqrstuvwxyz0123', ['abcd1234']);
    expect(out).not.toContain('abcd1234');
    expect(out).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('[redacted]');
  });

  test('HTTP-error message does not leak the JWT it sent', async () => {
    const http = mockHttp([{ status: 401, statusText: 'Unauthorized', body: '{"message":"Bad credentials"}' }]);
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown).toBeDefined();
    // The JWT that was sent must not appear in the error.
    const sentJwt = http.calls[0].opts.headers.Authorization.replace(/^Bearer /, '');
    expect(thrown.message).not.toContain(sentJwt);
    expect(thrown.message).not.toContain(privateKey);
    expect(thrown.message).toMatch(/HTTP 401 Unauthorized/);
  });

  test('transport rejection message does not leak the private key', async () => {
    const http = async () => { throw new Error('network down'); };
    const auth = new GitHubAppAuth({ appId: '1', installationId: '2', privateKey, httpPostJson: http });
    let thrown;
    await auth.getInstallationToken().catch((e) => { thrown = e; });
    expect(thrown.message).not.toContain(privateKey);
    expect(thrown.message).toMatch(/network down/);
  });
});

// ---------------------------------------------------------------------------
// Secret resolution / config errors
// ---------------------------------------------------------------------------

describe('resolveGitHubAppCredentials', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n';

  test('resolves identifiers from env vars and reads the private key file', () => {
    const env = {
      APP_ID: '123456',
      INSTALL_ID: '78901234',
      KEY_PATH: '/secrets/app-key.pem',
    };
    const reads = [];
    const creds = resolveGitHubAppCredentials(
      {
        mode: 'github-app',
        appIdEnv: 'APP_ID',
        installationIdEnv: 'INSTALL_ID',
        privateKeyPathEnv: 'KEY_PATH',
      },
      { env, readFile: (p) => { reads.push(p); return PEM; } },
    );
    expect(creds).toEqual({ appId: '123456', installationId: '78901234', privateKey: PEM });
    expect(reads).toEqual(['/secrets/app-key.pem']);
  });

  test('resolves a *Key reference through the injected key resolver', () => {
    const creds = resolveGitHubAppCredentials(
      {
        mode: 'github-app',
        appIdKey: 'n8n-ai/github/app-id',
        installationIdKey: 'n8n-ai/github/installation-id',
        privateKeyPathKey: 'n8n-ai/github/private-key-path',
      },
      {
        env: {},
        resolveKey: (k) => ({
          'n8n-ai/github/app-id': '111',
          'n8n-ai/github/installation-id': '222',
          'n8n-ai/github/private-key-path': '/k.pem',
        })[k],
        readFile: () => PEM,
      },
    );
    expect(creds).toEqual({ appId: '111', installationId: '222', privateKey: PEM });
  });

  test('throws when a referenced env var is missing', () => {
    expect(() =>
      resolveGitHubAppCredentials(
        { mode: 'github-app', appIdEnv: 'MISSING', installationIdEnv: 'I', privateKeyPathEnv: 'K' },
        { env: { I: '2', K: '/k.pem' }, readFile: () => PEM },
      ),
    ).toThrow(/environment variable "MISSING".*is not set/);
  });

  test('throws when the private key file cannot be read', () => {
    expect(() =>
      resolveGitHubAppCredentials(
        { mode: 'github-app', appIdEnv: 'A', installationIdEnv: 'I', privateKeyPathEnv: 'K' },
        {
          env: { A: '1', I: '2', K: '/nope.pem' },
          readFile: () => { throw new Error('ENOENT: no such file'); },
        },
      ),
    ).toThrow(/failed to read private key file/);
  });

  test('throws when a *Key reference has no resolver configured', () => {
    expect(() =>
      resolveGitHubAppCredentials(
        { mode: 'github-app', appIdKey: 'k/app', installationIdEnv: 'I', privateKeyPathEnv: 'K' },
        { env: { I: '2', K: '/k.pem' }, readFile: () => PEM },
      ),
    ).toThrow(/no credential-key resolver configured/);
  });
});

// ---------------------------------------------------------------------------
// createGhRunnerForAuth
// ---------------------------------------------------------------------------

describe('createGhRunnerForAuth', () => {
  test('gh mode returns a runner without performing a token exchange', async () => {
    const http = mockHttp([]);
    const runner = await createGhRunnerForAuth({ mode: 'gh' }, { httpPostJson: http });
    expect(typeof runner.run).toBe('function');
    expect(http.calls).toHaveLength(0);
  });

  test('github-app mode resolves credentials and exchanges for a token', async () => {
    const http = mockHttp([TOKEN_OK('ghs_runnertoken0000000000000000', '2030-01-01T00:00:00Z')]);
    const runner = await createGhRunnerForAuth(
      {
        mode: 'github-app',
        appIdEnv: 'A',
        installationIdEnv: 'I',
        privateKeyPathEnv: 'K',
      },
      {
        env: { A: '123', I: '456', K: '/k.pem' },
        readFile: () => privateKey,
        httpPostJson: http,
      },
    );
    expect(typeof runner.run).toBe('function');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://api.github.com/app/installations/456/access_tokens');
  });

  test('api-token mode is rejected for the GitHub provider layer', async () => {
    await expect(
      createGhRunnerForAuth({ mode: 'api-token', tokenEnv: 'T' }),
    ).rejects.toThrow(/Unsupported GitHub provider auth mode/);
  });
});

// ---------------------------------------------------------------------------
// ghRunnerWithToken — token-resolution failures stay retryable, never throw
// ---------------------------------------------------------------------------

describe('ghRunnerWithToken', () => {
  test('returns a non-zero result with redacted stderr when token resolution throws', () => {
    // A synchronous refresh failure (network outage / revoked creds) must not
    // escape run(): callers like the outbox dispatcher rely on a non-zero result
    // to keep the entry retryable instead of aborting the whole process.
    const runner = ghRunnerWithToken(() => {
      throw new Error('network down');
    });
    const result = runner.run(['api', 'repos/o/r/issues/1/comments'], { cwd: '/tmp' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GitHub App token resolution failed');
    expect(result.stderr).toContain('network down');
  });

  test('redacts any GitHub token that leaks into a token-resolution error', () => {
    const runner = ghRunnerWithToken(() => {
      throw new Error('boom ghs_leaked0000000000000000000000 boom');
    });
    const result = runner.run(['api', 'x'], { cwd: '/tmp' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain('ghs_leaked0000000000000000000000');
    expect(result.stderr).toContain('[redacted]');
  });
});
