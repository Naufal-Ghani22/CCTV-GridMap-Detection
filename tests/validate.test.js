const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCameraInput } = require('../lib/validate');

const base = { id: 'cctv-t1-030', area: 'Boarding', location: 'Gate B3' };

test('normalizes a new camera with defaults by lens shape', () => {
  const camera = normalizeCameraInput({ ...base, shape: 'Bullet', x: 0, y: '12.5', angle: -90 });
  assert.equal(camera.code, 'CCTV-T1-030');
  assert.equal(camera.x, 0, 'x = 0 must not fall back to the map centre');
  assert.equal(camera.y, 12.5);
  assert.equal(camera.details.angle, 270);
  assert.equal(camera.details.fov, 60);
  assert.equal(camera.details.range, 1.5);
  assert.equal(camera.details.floor, 'gf');
  assert.equal(camera.details.status, 'normal');
});

test('clamps map coordinates and coverage values', () => {
  const camera = normalizeCameraInput({ ...base, x: 140, y: -3, fov: 900, range: 0 });
  assert.equal(camera.x, 100);
  assert.equal(camera.y, 0);
  assert.equal(camera.details.fov, 360);
  assert.equal(camera.details.range, 0.2);
});

test('rejects unknown enums, wrong types, and bad identifiers', () => {
  for (const payload of [
    { ...base, status: 'hack' },
    { ...base, floor: 'roof' },
    { ...base, shape: 'Box' },
    { ...base, brand: {} },
    { ...base, installed: '12/03/2024' },
    { ...base, ip: '999.1.1.1' },
    { ...base, x: 'left' },
    { ...base, id: 'a b' },
    { ...base, area: '' },
  ]) {
    assert.throws(() => normalizeCameraInput(payload), { status: 400 }, JSON.stringify(payload));
  }
});

test('a partial update keeps untouched fields', () => {
  const current = { camera_code: 'CCTV-T1-030', name: 'CCTV-T1-030', area: 'Boarding', ip_address: '192.168.1.64/32', map_x: '20.000', map_y: '30.000', details: { angle: 45, fov: 90, range: 2, brand: 'Hikvision', floor: 'ff' } };
  const camera = normalizeCameraInput({ angle: 370 }, current);
  assert.equal(camera.details.angle, 10);
  assert.equal(camera.details.brand, 'Hikvision');
  assert.equal(camera.details.floor, 'ff');
  assert.equal(camera.ip, '192.168.1.64');
  assert.equal(camera.x, 20);
});
