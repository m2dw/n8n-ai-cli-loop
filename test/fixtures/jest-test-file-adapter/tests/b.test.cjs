const fs = require('fs');
const path = require('path');

const ran = path.join(__dirname, '..', 'ran');
fs.mkdirSync(ran, { recursive: true });
fs.writeFileSync(path.join(ran, 'b'), '');

test('B passes', () => {
  expect(1 + 1).toBe(2);
});
