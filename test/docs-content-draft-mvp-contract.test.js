/**
 * Structural tests for docs/content-draft-mvp-contract.md.
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

const doc = read('docs/content-draft-mvp-contract.md');

// ---------------------------------------------------------------------------
// Trust model and execution environment
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — trust model', () => {
  test('states inputs are treated as untrusted', () => {
    expect(doc).toMatch(/untrusted/i);
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

describe('docs/content-draft-mvp-contract.md — operational separation', () => {
  test('specifies agent cwd is the per-run artifact directory', () => {
    expect(doc).toMatch(/cwd.*artifact|artifact.*dir.*cwd|per-run artifact/i);
  });

  test('states handler writes outputs to the artifact directory', () => {
    expect(doc).toMatch(/artifact.*dir|per-run.*artifact/i);
  });

  test('explicitly states no OS or container sandbox', () => {
    expect(doc).toMatch(/OS.level.*sandbox|container.level|not.*sandbox|no.*sandbox|does not.*sandbox/i);
  });

  test('states the draft does not modify the target repository', () => {
    expect(doc).toMatch(/does not.*modify|not.*modify|no.*git|not.*push|not.*commit/i);
  });
});

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — input contract', () => {
  test('names issue title and body as accepted inputs', () => {
    expect(doc).toMatch(/title/i);
    expect(doc).toMatch(/body/i);
  });

  test('states the research brief is identified through task-context metadata', () => {
    expect(doc).toMatch(/task.context.*metadata|stable.*task.context|artifact.*metadata/i);
  });

  test('states raw research stdout/stderr/diagnostics are excluded', () => {
    expect(doc).toMatch(/stdout|stderr|diagnostic/i);
    expect(doc).toMatch(/excluded|must not|do not|not.*pass/i);
  });

  test('states local filesystem paths are excluded', () => {
    expect(doc).toMatch(/local.*filesystem.*path|filesystem.*path.*must.*not|local.*paths/i);
  });
});

// ---------------------------------------------------------------------------
// Artifact contract
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — artifact contract', () => {
  test('names content-draft-prompt.md as a required artifact', () => {
    expect(doc).toContain('content-draft-prompt.md');
  });

  test('names content-draft-output.md as a required artifact', () => {
    expect(doc).toContain('content-draft-output.md');
  });

  test('names content-draft-result.json as a required artifact', () => {
    expect(doc).toContain('content-draft-result.json');
  });

  test('states artifacts are local only and not forwarded', () => {
    expect(doc).toMatch(/local.*only|never.*forwarded|not.*forwarded/i);
  });
});

// ---------------------------------------------------------------------------
// Public-status contract
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — public-status contract', () => {
  test('states raw draft text remains in local artifacts only', () => {
    expect(doc).toMatch(/local.*artifact|artifact.*only|local.*run.*artifact/i);
  });

  test('states outcome enum contains draft_complete, draft_failed, and input_invalid', () => {
    expect(doc).toContain('draft_complete');
    expect(doc).toContain('draft_failed');
    expect(doc).toContain('input_invalid');
  });

  test('states credentials and secrets must not appear in GitHub-visible output', () => {
    expect(doc).toMatch(/credential|secret|token/i);
  });

  test('states local filesystem paths must not appear in structured outcome fields', () => {
    expect(doc).toMatch(/local.*filesystem.*path|filesystem.*path.*must.*not|local.*paths/i);
  });
});

// ---------------------------------------------------------------------------
// Repository-mutation policy
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — repository-mutation policy', () => {
  test('states no git operations are run by the draft handler', () => {
    expect(doc).toMatch(/no.*git|not.*run.*git|git.*operations.*not/i);
  });

  test('states no gh operations are run by the draft handler', () => {
    expect(doc).toMatch(/no.*gh|not.*run.*gh|gh.*operations.*not/i);
  });

  test('states draft and self-review remain local run artifacts', () => {
    expect(doc).toMatch(/local.*artifact|remain.*local/i);
  });
});

// ---------------------------------------------------------------------------
// Deferred capabilities
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — deferred capabilities', () => {
  test('lists OS/container sandbox as deferred', () => {
    expect(doc).toMatch(/OS.*container.*sandbox|container.*sandbox/i);
  });

  test('lists publication or export to target repository as deferred', () => {
    expect(doc).toMatch(/publication|export.*draft|publish/i);
  });

  test('lists structural prompt-injection boundary as deferred', () => {
    expect(doc).toMatch(/prompt.injection.*bound|delimiter.*isolation|structural.*prompt/i);
  });

  test('lists broader redaction framework as deferred', () => {
    expect(doc).toMatch(/redaction.*framework|broader.*redaction/i);
  });
});

// ---------------------------------------------------------------------------
// Reviewer policy
// ---------------------------------------------------------------------------

describe('docs/content-draft-mvp-contract.md — reviewer policy', () => {
  test('states OS/container sandboxing must not be required as a P1 blocker', () => {
    expect(doc).toMatch(/P1.*blocker|blocker.*P1|reviewer.*must.*not|not.*block/i);
  });
});
