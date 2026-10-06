const assert = require('node:assert/strict');
const test = require('node:test');

const { decryptRtsp, encryptRtsp } = require('../lib/rtsp-secrets');

test('RTSP encryption round-trips without leaving credentials or address in ciphertext', () => {
  const key = Buffer.alloc(32, 9);
  const secret = 'rtsp://viewer:password@192.168.1.64/live';
  const ciphertext = encryptRtsp(secret, key);
  assert.doesNotMatch(ciphertext, /viewer|password|192\.168\.1\.64/);
  assert.equal(decryptRtsp(ciphertext, key), secret);
});

test('RTSP decryption rejects altered ciphertext', () => {
  const key = Buffer.alloc(32, 9);
  const ciphertext = encryptRtsp('rtsp://192.168.1.64/live', key);
  assert.throws(() => decryptRtsp(`${ciphertext}x`, key), /RTSP/);
});
