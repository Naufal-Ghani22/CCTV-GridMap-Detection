const assert = require('node:assert/strict');
const test = require('node:test');

const { hashPassword, verifyPassword } = require('../lib/passwords');

test('stores a salted password hash that verifies only the original password', async () => {
  const hash = await hashPassword('bootstrap-password-123');
  assert.notEqual(hash, 'bootstrap-password-123');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('bootstrap-password-123', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('rejects malformed password hashes without throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-password-hash'), false);
});
