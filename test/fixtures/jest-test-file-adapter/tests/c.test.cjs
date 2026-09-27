const fs = require('fs');
const path = require('path');

const ran = path.join(__dirname, '..', 'ran');
fs.mkdirSync(ran, { recursive: true });
fs.writeFileSync(path.join(ran, 'c'), '');

// Reached, but executes no test: its outcome is `skipped`, never `passed`.
test.skip('C is skipped', () => {
  expect(true).toBe(false);
});
