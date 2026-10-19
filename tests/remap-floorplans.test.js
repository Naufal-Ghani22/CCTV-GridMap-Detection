const assert = require('node:assert/strict');
const test = require('node:test');
const { FRAMES, convert, remapFloorplans } = require('../db/remap-floorplans');

test('a camera keeps its real-world spot when the plan frame changes', () => {
  // Old 49.3 % / 46.7 % on the ground floor is PDF point (546.0, 369.5).
  const moved = convert(FRAMES.gf, 49.3, 46.7);
  assert.ok(Math.abs(moved.x - 45.19) < 0.02, `x ${moved.x}`);
  assert.ok(Math.abs(moved.y - 45.57) < 0.02, `y ${moved.y}`);
  const corner = convert(FRAMES.ff, 0, 0);
  assert.ok(corner.x >= 0 && corner.x < 1 && corner.y > 18 && corner.y < 20, JSON.stringify(corner));
});

test('remap runs once and skips floors with an imported custom plan', async () => {
  const updates = [];
  let flag = null;
  const client = {
    async query(sql, values) {
      if (/^(BEGIN|COMMIT|ROLLBACK)|^LOCK/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT setting_value')) return { rows: flag ? [{ setting_value: flag }] : [] };
      if (sql.includes("LIKE 'map:%'")) return { rows: [{ setting_key: 'map:ff' }] };
      if (sql.startsWith('SELECT id, map_x')) return { rows: [{ id: 'a', map_x: '50', map_y: '50', details: { floor: 'gf' } }, { id: 'b', map_x: '50', map_y: '50', details: { floor: 'ff' } }] };
      if (sql.startsWith('UPDATE cameras')) { updates.push(values[2]); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO settings')) { flag = JSON.parse(values[1]); return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client };
  assert.deepEqual(await remapFloorplans(pool), { skipped: false, moved: 1 });
  assert.deepEqual(updates, ['a']);
  assert.deepEqual(await remapFloorplans(pool), { skipped: true, moved: 0 });
});
