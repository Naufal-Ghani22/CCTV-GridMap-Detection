const crypto = require('node:crypto');

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Kunci enkripsi RTSP harus tepat 32 byte.');
  }
}

function encryptRtsp(url, key) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('URL RTSP tidak valid.');
  assertKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptRtsp(value, key) {
  assertKey(key);
  try {
    const parts = typeof value === 'string' ? value.split('.') : [];
    if (parts.length !== 3) throw new Error('format');
    const [iv, tag, ciphertext] = parts.map((part) => {
      if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('format');
      const decoded = Buffer.from(part, 'base64url');
      if (decoded.toString('base64url') !== part) throw new Error('format');
      return decoded;
    });
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Data RTSP tersimpan tidak dapat didekripsi.');
  }
}

module.exports = { decryptRtsp, encryptRtsp };
