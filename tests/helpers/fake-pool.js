// Minimal pg Pool stand-in for HTTP tests that do not need a real database.
const SESSION_USER = { id: '11111111-1111-4111-8111-111111111111', email: 'operator@airport.local', role: 'operator', display_name: 'Operator', division: 'Operasional' };
const SESSION_COOKIE = 'cctv_session=test-session-token-that-is-long-enough';

function createFakePool({ user = SESSION_USER, handlers = [] } = {}) {
  const calls = [];
  async function query(sql, values) {
    calls.push({ sql, values });
    for (const [pattern, reply] of handlers) {
      if (typeof pattern === 'string' ? sql.includes(pattern) : pattern.test(sql)) return typeof reply === 'function' ? reply(sql, values) : reply;
    }
    if (sql.includes('FROM sessions')) return { rows: user && values?.[0] ? [user] : [] };
    if (sql.startsWith('INSERT INTO activity_history')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  const client = { query, release() {} };
  return { query, connect: async () => client, calls };
}

module.exports = { SESSION_COOKIE, SESSION_USER, createFakePool };
