// Minimal server side of RFC 6455 for one-way binary streams (server -> browser).
// The View wall uses it because WebSockets do not count against the browser's limit of six
// HTTP/1.1 connections per server; plain <video src> streams would starve the app's API calls.
const crypto = require('node:crypto');
const { STATUS_CODES } = require('node:http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENT_FRAME = 64 * 1024;

function rejectUpgrade(socket, status) {
  if (!socket.writable) return socket.destroy();
  return socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return [header, payload];
}

// Returns false when the socket buffer is full, like stream.write().
function sendBinary(socket, payload) {
  const [header, body] = frame(0x2, payload);
  socket.cork();
  socket.write(header);
  const ok = socket.write(body);
  socket.uncork();
  return ok;
}

function closeWebSocket(socket) {
  if (socket.writable) socket.end(Buffer.concat(frame(0x8)));
}

// A video viewer only sends control frames: answer ping and close, ignore the rest.
function readControlFrames(socket) {
  let pending = Buffer.alloc(0);
  socket.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        return socket.destroy();
      }
      if (length > MAX_CLIENT_FRAME) return socket.destroy();
      const end = offset + (masked ? 4 : 0) + length;
      if (pending.length < end) return;
      const payload = Buffer.from(pending.subarray(end - length, end));
      if (masked) {
        const mask = pending.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      pending = pending.subarray(end);
      if (opcode === 0x8) return closeWebSocket(socket);
      if (opcode === 0x9 && socket.writable) socket.write(Buffer.concat(frame(0xa, payload)));
    }
  });
}

// Completes the handshake; returns false (and answers 400) for a request that is not a valid WebSocket upgrade.
function acceptWebSocket(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || !key) {
    rejectUpgrade(socket, 400);
    return false;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.setNoDelay(true);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  readControlFrames(socket);
  return true;
}

module.exports = { acceptWebSocket, closeWebSocket, rejectUpgrade, sendBinary };
