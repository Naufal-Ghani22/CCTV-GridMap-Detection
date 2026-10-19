// Fixed-window limiter kept in memory; enough for a single LAN server process.

function createRateLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();

  function hit(key) {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= max;
    return { allowed, retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) };
  }

  function reset(key) {
    entries.delete(key);
  }

  function prune() {
    const time = now();
    for (const [key, entry] of entries) if (entry.resetAt <= time) entries.delete(key);
  }

  const timer = setInterval(prune, Math.min(windowMs, 60 * 1000));
  timer.unref();

  return { hit, reset, prune, stop: () => clearInterval(timer), size: () => entries.size };
}

module.exports = { createRateLimiter };
