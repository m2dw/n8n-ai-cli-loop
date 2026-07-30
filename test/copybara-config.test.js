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
