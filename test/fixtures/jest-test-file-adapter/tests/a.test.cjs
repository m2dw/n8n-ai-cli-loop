const fs = require('fs');
const path = require('path');

// Leave a marker so the driving test can see this file was reached.
const ran = path.join(__dirname, '..', 'ran');
fs.mkdirSync(ran, { recursive: true });
fs.writeFileSync(path.join(ran, 'a'), '');

test('A reads the built answer from dist', () => {
  expect(require('../dist/values.cjs').answer).toBe(42);
});
