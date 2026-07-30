import { readFileSync } from 'fs';
import { DEFAULT_CONFIG_TEMPLATE } from '../scripts/copybara-export.mjs';

// Guards against issue #798: the pinned Copybara release (v20260727) has no
// `message` kwarg on core.workflow() — passing one fails the whole config at
// load time ("workflow() got unexpected keyword argument 'message'"), before
// migrate ever runs. These tests read the checked-in template itself (not a
// test fixture) so a future edit can't silently reintroduce the unsupported
// argument.
describe('copybara/copy.bara.sky — v20260727 core.workflow() compatibility', () => {
  const config = readFileSync(DEFAULT_CONFIG_TEMPLATE, 'utf8');

  test('does not pass a top-level `message` argument to core.workflow', () => {
    expect(config).not.toMatch(/^\s*message\s*=/m);
  });

  test('sets the fixed public commit message via metadata.replace_message', () => {
    expect(config).toMatch(/metadata\.replace_message\(/);
    expect(config).toMatch(/Public snapshot export/);
    expect(config).toMatch(/No private commit history or commit messages are included/);
  });

  test('keeps SQUASH mode, file filters, and bot authoring unchanged', () => {
    expect(config).toMatch(/mode\s*=\s*"SQUASH"/);
    expect(config).toMatch(/authoring\.overwrite\(/);
    expect(config).toMatch(/origin_files\s*=\s*glob\(/);
    expect(config).toMatch(/destination_files\s*=\s*glob\(/);
  });
});

// Regression guard for issue #811: docs/handlers-extraction-plan.md and its
// structural test both read docs/DOMAIN.md and
// docs/design/handlers-responsibility-inventory.md at module load time.
// Those two are PRIVATE_ONLY_PATHS, so exporting the plan/test without them
// produced a dangling ENOENT in the public repo's own CI. Fixed by excluding
// the plan/test themselves (not by exporting the private-only docs).
describe('copybara/copy.bara.sky — issue #811 handlers-extraction-plan dependency closure', () => {
  const config = readFileSync(DEFAULT_CONFIG_TEMPLATE, 'utf8');

  test('excludes docs/handlers-extraction-plan.md and its structural test from origin_files', () => {
    expect(config).toMatch(/INTERNAL_PLANNING_PATHS\s*=\s*\[/);
    expect(config).toMatch(/"docs\/handlers-extraction-plan\.md"/);
    expect(config).toMatch(/"test\/docs-handlers-extraction-plan\.test\.js"/);
    const originFiles = config.match(/origin_files\s*=\s*glob\(\s*\[[^\]]*\],\s*exclude\s*=\s*([^,]+),/);
    expect(originFiles).not.toBeNull();
    expect(originFiles[1]).toMatch(/INTERNAL_PLANNING_PATHS/);
    expect(originFiles[1]).toMatch(/PRIVATE_ONLY_PATHS/);
  });

  test('does not solve this by exporting DOMAIN.md or docs/design (private-only paths stay excluded)', () => {
    expect(config).toMatch(/PRIVATE_ONLY_PATHS\s*=\s*\[/);
    expect(config).toMatch(/"docs\/DOMAIN\.md"/);
    expect(config).toMatch(/"docs\/design\/\*\*"/);
  });
});
