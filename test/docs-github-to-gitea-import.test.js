/**
 * Structural tests for docs/github-to-gitea-import.md (issue #364).
 *
 * These assert that the import-model spec covers each acceptance-criteria topic
 * so the public-GitHub-to-private-Gitea import contract cannot silently lose a
 * required section. They are not a behavioral test of an importer (none is
 * implemented by this issue) — only that the specification's reference points
 * are present.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/github-to-gitea-import.md');
const providerArch = read('docs/provider-architecture.md');
const giteaDoc = read('docs/gitea-private-work-items.md');

// ---------------------------------------------------------------------------
// Specification-only scope
// ---------------------------------------------------------------------------

describe('scope', () => {
  test('declares itself design/specification only', () => {
    expect(doc).toMatch(/design specification only/i);
  });

  test('does not implement synchronization or the Gitea provider API', () => {
    expect(doc).toMatch(/synchronization and\s+the Gitea provider API are not implemented/i);
  });
});

// ---------------------------------------------------------------------------
// One-way import direction / first-class design goal
// ---------------------------------------------------------------------------

describe('import direction', () => {
  test('states import is one-way into Gitea by default', () => {
    expect(doc).toMatch(/one-way/i);
    expect(doc).toMatch(/pull-only into Gitea|into Gitea/i);
  });

  test('makes hiding raw AI interaction from public GitHub a first-class goal', () => {
    expect(doc).toMatch(/first-class design goal/i);
    expect(doc).toMatch(/Raw AI interaction stays hidden from the public\s+GitHub/i);
  });

  test('has no default GitHub write-back path', () => {
    expect(doc).toMatch(/nothing by default|nothing, by default/i);
  });
});

// ---------------------------------------------------------------------------
// MVP behavior decisions
// ---------------------------------------------------------------------------

describe('MVP behavior', () => {
  test('chooses manual import over automatic sync', () => {
    expect(doc).toMatch(/MVP\s*=\s*manual import/i);
    expect(doc).toMatch(/[Aa]utomatic sync is future work/);
  });

  test('stores a private→public backlink but no default public→private backlink', () => {
    expect(doc).toMatch(/Gitea\s*→\s*public GitHub:\s*yes/i);
    expect(doc).toMatch(/Public GitHub\s*→\s*private Gitea:\s*no/i);
  });

  test('imports an allow-list of fields, not copy-everything', () => {
    expect(doc).toMatch(/allow-list/i);
    expect(doc).toMatch(/title/i);
    expect(doc).toMatch(/issue body/i);
    expect(doc).toMatch(/labels/i);
    expect(doc).toMatch(/selected comments/i);
    expect(doc).toMatch(/reporter metadata/i);
  });

  test('bounds imported text and marks it untrusted before it reaches a prompt', () => {
    expect(doc).toMatch(/[Bb]ounded/);
    expect(doc).toMatch(/[Mm]arked untrusted/);
    expect(doc).toMatch(/reach an agent prompt|agent prompt/i);
  });

  test('requires manual re-import for comments posted after import', () => {
    expect(doc).toMatch(/manual re-import/i);
  });

  test('posts no status back to GitHub by default', () => {
    expect(doc).toMatch(/Status posted back to GitHub/i);
    expect(doc).toMatch(/nothing, by default/i);
  });
});

// ---------------------------------------------------------------------------
// Security requirements
// ---------------------------------------------------------------------------

describe('security requirements', () => {
  test('treats public GitHub body and comments as untrusted input', () => {
    expect(doc).toMatch(/untrusted input/i);
  });

  test('forbids imported text from altering control-plane policy', () => {
    expect(doc).toMatch(/provider config/i);
    expect(doc).toMatch(/tool policy/i);
    expect(doc).toMatch(/visibility policy/i);
    expect(doc).toMatch(/credentials/i);
    expect(doc).toMatch(/publication targets/i);
  });

  test('forbids posting raw AI artifacts back to public GitHub', () => {
    expect(doc).toMatch(/[Rr]aw AI artifacts must never be posted back to public GitHub/);
  });

  test('forbids leaking local paths, private Gitea URLs, tokens, or artifacts', () => {
    expect(doc).toMatch(/local filesystem paths/i);
    expect(doc).toMatch(/private Gitea URLs/i);
    expect(doc).toMatch(/tokens/i);
    expect(doc).toMatch(/artifact references/i);
  });

  test('explains how prompt-injection risk is bounded during import', () => {
    expect(doc).toMatch(/How prompt-injection risk is bounded during import/i);
    expect(doc).toMatch(/allow-list/i);
    expect(doc).toMatch(/[Nn]o write-back/);
  });
});

// ---------------------------------------------------------------------------
// MVP vs future phases
// ---------------------------------------------------------------------------

describe('MVP vs future phases', () => {
  test('separates MVP from future phases', () => {
    expect(doc).toMatch(/MVP vs Future Phases/i);
  });

  test('names automatic import/sync as a future, separately-scoped slice', () => {
    expect(doc).toMatch(/[Aa]utomatic import\/sync/);
    expect(doc).toMatch(/future/i);
  });

  test('identifies follow-up issues only if automatic sync is approved', () => {
    expect(doc).toMatch(/follow-up implementation issues/i);
    expect(doc).toMatch(/only if/i);
  });
});

// ---------------------------------------------------------------------------
// Cross-linking
// ---------------------------------------------------------------------------

describe('cross-linking', () => {
  test('links back to provider-architecture.md', () => {
    expect(doc).toMatch(/provider-architecture\.md/);
  });

  test('links back to gitea-private-work-items.md', () => {
    expect(doc).toMatch(/gitea-private-work-items\.md/);
  });

  test('provider-architecture.md links to the import spec', () => {
    expect(providerArch).toMatch(/github-to-gitea-import\.md/);
  });

  test('gitea-private-work-items.md links to the import spec', () => {
    expect(giteaDoc).toMatch(/github-to-gitea-import\.md/);
  });
});
