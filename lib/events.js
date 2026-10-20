// Server-Sent Events hub: every open browser gets a nudge when shared data changes.
const { SECURITY_HEADERS } = require('./http');

function createEventHub({ heartbeatMs = 25000 } = {}) {
  const clients = new Set();

  function write(response, type, data) {
    response.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  }

  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  return {
    connect(request, response, user) {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      response.write('retry: 5000\n\n');
      write(response, 'hello', { userId: user.id, at: new Date().toISOString() });
      clients.add(response);
      request.on('close', () => clients.delete(response));
    },
    broadcast(type, data) {
      for (const response of clients) write(response, type, data);
    },
    size: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const response of clients) response.end();
      clients.clear();
    },
  };
}

module.exports = { createEventHub };
