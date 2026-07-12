/**
 * Structural tests for docs/gitea-private-work-items.md (issue #360).
 *
 * These assert that the spec covers each acceptance-criteria topic so the
 * private-work-item design contract cannot silently lose a required section.
 * They are not a behavioral test of a Gitea provider (none is implemented by
 * this issue) — only that the specification's reference points are present.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const doc = read('docs/gitea-private-work-items.md');
const providerArch = read('docs/provider-architecture.md');

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

describe('topology', () => {
  test('documents Gitea as the WorkItemProvider', () => {
    expect(doc).toMatch(/WorkItemProvider\s*=\s*Gitea/);
  });

  test('documents GitHub as the RepoHostProvider', () => {
    expect(doc).toMatch(/RepoHostProvider\s*=\s*GitHub/);
  });

  test('keeps public GitHub issues user-facing', () => {
    expect(doc).toMatch(/user-facing/i);
  });
});

// ---------------------------------------------------------------------------
// First-class design goal: hide AI interaction from public GitHub
// ---------------------------------------------------------------------------

describe('first-class design goal', () => {
  test('states hiding AI interaction from public GitHub is a primary goal', () => {
    expect(doc).toMatch(/first-class design goal/i);
    expect(doc).toMatch(/Hiding AI interaction from the public GitHub/i);
  });
});

// ---------------------------------------------------------------------------
// Untrusted private content
// ---------------------------------------------------------------------------

describe('untrusted input', () => {
  test('states private Gitea content is still untrusted agent input', () => {
    expect(doc).toMatch(/private[\s\S]{0,40}not[\s\S]{0,20}trusted|still not "trusted"/i);
    expect(doc).toMatch(/Gitea[\s\S]{0,40}issue bodies\/comments[\s\S]{0,40}untrusted/i);
  });

  test('marks both GitHub and Gitea issue/comment text as untrusted input', () => {
    expect(doc).toMatch(/untrusted input/i);
  });
});

// ---------------------------------------------------------------------------
// Visibility tiers
// ---------------------------------------------------------------------------

describe('visibility tiers', () => {
  test('defines a raw, local-only tier', () => {
    expect(doc).toMatch(/Tier 0/);
    expect(doc).toMatch(/local only/i);
    expect(doc).toMatch(/\.n8n-artifacts/);
  });

  test('defines a bounded/sanitized private work-item tier', () => {
    expect(doc).toMatch(/Tier 1/);
    expect(doc).toMatch(/bounded/i);
    expect(doc).toMatch(/saniti/i);
  });

  test('defines a summarized public GitHub tier with no raw prompts/paths/secrets', () => {
    expect(doc).toMatch(/Tier 2/);
    expect(doc).toMatch(/No raw prompts/i);
    expect(doc).toMatch(/no secrets/i);
    expect(doc).toMatch(/no local filesystem paths|no local paths/i);
  });

  test('distinguishes the four surfaces', () => {
    expect(doc).toMatch(/[Ll]ocal artifacts/);
    expect(doc).toMatch(/[Ii]nternal AI comments/);
    expect(doc).toMatch(/PR comments/);
    expect(doc).toMatch(/[Uu]ser-facing issue comments/);
  });
});

// ---------------------------------------------------------------------------
// Prompt-injection boundary
// ---------------------------------------------------------------------------

describe('prompt-injection boundary', () => {
  test('untrusted text may describe behavior but not override policy', () => {
    expect(doc).toMatch(/describe[\s\S]{0,40}behavior/i);
    expect(doc).toMatch(/override/i);
  });

  test('enumerates the protected policy domains', () => {
    expect(doc).toMatch(/security policy/i);
    expect(doc).toMatch(/provider\/config policy|provider\/?config/i);
    expect(doc).toMatch(/output\/visibility policy|output\/?visibility/i);
    expect(doc).toMatch(/tool policy/i);
  });

  test('forbids treating issue text as authority to publish secrets, change config, bypass review, or expand tools', () => {
    expect(doc).toMatch(/publish secrets/i);
    expect(doc).toMatch(/bypass[\s\S]{0,30}review/i);
    expect(doc).toMatch(/expand tool access/i);
  });
});

// ---------------------------------------------------------------------------
// Provider scope
// ---------------------------------------------------------------------------

describe('provider scope', () => {
  test('puts the Gitea WorkItemProvider in the first wave', () => {
    expect(doc).toMatch(/In scope[\s\S]{0,160}Gitea `WorkItemProvider`/i);
  });

  test('marks Gitea RepoHostProvider as future work', () => {
    expect(doc).toMatch(/Gitea `RepoHostProvider`[\s\S]{0,120}future/i);
  });

  test('marks GitHub-to-Gitea public issue sync as future work', () => {
    expect(doc).toMatch(/sync[\s\S]{0,80}future/i);
  });

  test('warns implementers not to assume Gitea is GitHub-compatible', () => {
    expect(doc).toMatch(/not[\s\S]{0,40}assume[\s\S]{0,60}GitHub-compatible|verify the actual\s+Gitea API/i);
  });
});

// ---------------------------------------------------------------------------
// Dependency degradation
// ---------------------------------------------------------------------------

describe('dependency degradation', () => {
  test('addresses Gitea lacking GitHub Issue Relationships', () => {
    expect(doc).toMatch(/Issue Relationships/);
    expect(doc).toMatch(/getDependencies/);
  });

  test('fails safe (no fabricated dependencies) when the capability is absent', () => {
    expect(doc).toMatch(/fail safe, not fail open/i);
    expect(doc).toMatch(/no\s+dependencies/i);
  });
});

// ---------------------------------------------------------------------------
// Label / status mapping
// ---------------------------------------------------------------------------

describe('label/status mapping', () => {
  test('keeps internal workflow labels off the public GitHub repo', () => {
    expect(doc).toMatch(/label noise/i);
    expect(doc).toMatch(/does not increase|does \*\*not\*\* gain|not gain/i);
  });

  test('preserves the required stackReady transition', () => {
    expect(doc).toMatch(/stackReady/);
    expect(doc).toMatch(/required, not optional/i);
  });
});

// ---------------------------------------------------------------------------
// Follow-up slices
// ---------------------------------------------------------------------------

describe('follow-up slices', () => {
  test('names the provider-neutral outbox slice', () => {
    expect(doc).toMatch(/[Pp]rovider-neutral outbox/);
  });

  test('names the Gitea config + auth slice', () => {
    expect(doc).toMatch(/Gitea config \+ auth|Gitea config\/auth/i);
  });

  test('names the Gitea WorkItemProvider slice', () => {
    expect(doc).toMatch(/Gitea `WorkItemProvider`/);
  });
});

// ---------------------------------------------------------------------------
// Cross-linking
// ---------------------------------------------------------------------------

describe('cross-linking', () => {
  test('the new spec links back to provider-architecture.md', () => {
    expect(doc).toMatch(/provider-architecture\.md/);
  });

  test('provider-architecture.md links to the new spec', () => {
    expect(providerArch).toMatch(/gitea-private-work-items\.md/);
  });
});
