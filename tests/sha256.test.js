const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sha256Hex } = require('../sha256');

test('matches standard SHA-256 vectors and both demo credentials', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('Admin123!'), '3eb3fe66b31e3b4d10fa70b5cad49c7112294af6ae4e476a1c405155d45aa121');
  assert.equal(sha256Hex('User123!'), 'bc5848f227cc161eb5f68dfe98cb13110a9c843ce69e953a88107d865583d397');
});
