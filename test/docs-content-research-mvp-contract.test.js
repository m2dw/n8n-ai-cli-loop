/**
 * Structural tests for docs/content-research-mvp-contract.md.
 *
 * These tests verify that the contract document contains the key claims an
 * implementer or reviewer needs to understand what the MVP guarantees and what
 * it explicitly defers. They are not a substitute for runtime behaviour tests.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/content-research-mvp-contract.md');

// ---------------------------------------------------------------------------
// Trust model and execution environment
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — trust model', () => {
  test('states inputs are treated as untrusted despite human screening', () => {
    expect(doc).toMatch(/untrusted/i);
    expect(doc).toMatch(/human.*screen|screen.*human/i);
  });

  test('states prompt-injection isolation is a deferred capability', () => {
    expect(doc).toMatch(/prompt.injection/i);
    expect(doc).toMatch(/deferred/i);
  });

  test('states the execution environment is private', () => {
    expect(doc).toMatch(/private.*execution|private/i);
  });
});

// ---------------------------------------------------------------------------
// Operational separation
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — operational separation', () => {
  test('specifies agent cwd is the per-run artifact directory', () => {
    expect(doc).toMatch(/cwd.*artifact|artifact.*dir.*cwd/i);
  });

  test('states handler writes outputs to the artifact directory', () => {
    expect(doc).toMatch(/artifact.*dir|per-run.*artifact/i);
  });

  test('explicitly states no OS or container sandbox', () => {
    expect(doc).toMatch(/OS.level.*sandbox|container.level|not.*sandbox|no.*sandbox|does not.*sandbox/i);
  });
});

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — input contract', () => {
  test('names title, URL, and labels as accepted inputs', () => {
    expect(doc).toMatch(/title/i);
    expect(doc).toMatch(/URL/i);
    expect(doc).toMatch(/labels/i);
  });

  test('states issue body is accepted as bounded delimited input', () => {
    expect(doc).toMatch(/body.*bounded|bounded.*body/i);
    expect(doc).toMatch(/delimit/i);
  });

  test('states automatic external URL fetching is not supported', () => {
    expect(doc).toMatch(/automatic.*fetching|external.*URL.*not|URL.*not.*support/i);
  });

  test('states path@sha revision-aware resolution is not supported', () => {
    expect(doc).toMatch(/path@sha|revision.aware|not.*supported/i);
  });
});

// ---------------------------------------------------------------------------
// Public-status contract
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — public-status contract', () => {
  test('states raw output and research findings remain in local artifacts only', () => {
    expect(doc).toMatch(/local.*artifact|artifact.*only|local.*run.*artifact/i);
  });

  test('states GitHub output contains only fixed outcome/status value', () => {
    expect(doc).toMatch(/fixed.*outcome|outcome.*status|fixed.*public.safe/i);
  });

  test('states credentials and secrets must not appear in GitHub-visible output', () => {
    expect(doc).toMatch(/credential|secret|token/i);
  });

  test('states raw error objects or stack traces must not appear in structured outcome fields', () => {
    expect(doc).toMatch(/stack.*trace|raw.*error/i);
  });

  test('states local filesystem paths must not appear in structured outcome fields', () => {
    expect(doc).toMatch(/local.*filesystem.*path|filesystem.*path.*must.*not|local.*paths/i);
  });
});

// ---------------------------------------------------------------------------
// Deferred capabilities table
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — deferred capabilities', () => {
  test('lists OS/container sandbox as deferred', () => {
    expect(doc).toMatch(/OS.*container.*sandbox|container.*sandbox/i);
  });

  test('lists structural prompt-injection boundary as deferred', () => {
    expect(doc).toMatch(/prompt.injection.*bound|delimiter.*isolation|structural.*prompt/i);
  });

  test('lists repository source-file selection as deferred', () => {
    expect(doc).toMatch(/source.file.*selection|file.*selection.*isolation|source-file.*selection/i);
  });

  test('lists external URL fetching with SSRF policy as deferred', () => {
    expect(doc).toMatch(/SSRF|external.*source.*fetching/i);
  });

  test('lists path@sha git-revision-aware resolution as deferred', () => {
    expect(doc).toMatch(/path@sha|git.revision/i);
  });

  test('lists broader public-output redaction framework as deferred', () => {
    expect(doc).toMatch(/redaction.*framework|broader.*redaction/i);
  });

  test('lists repository source-file selection and isolation as deferred', () => {
    expect(doc).toMatch(/source.file.*selection|file.*selection.*isolation/i);
  });
});

// ---------------------------------------------------------------------------
// Reviewer policy
// ---------------------------------------------------------------------------

describe('docs/content-research-mvp-contract.md — reviewer policy', () => {
  test('states OS/container sandboxing must not be required as a P1 blocker', () => {
    expect(doc).toMatch(/P1.*blocker|blocker.*P1|reviewer.*must.*not|not.*block/i);
  });
});
