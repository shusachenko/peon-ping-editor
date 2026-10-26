'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { writeZip, readZip, crc32 } = require('../src/zip');

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('round-trips text and binary entries', () => {
  const a = Buffer.from('hello '.repeat(500));
  const b = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) & 0xff));
  const out = readZip(writeZip([{ name: 'dir/a.txt', data: a }, { name: 'dir/b.bin', data: b }, { name: 'ünïcode.txt', data: Buffer.from('x') }]));
  assert.deepEqual(out.map((e) => e.name), ['dir/a.txt', 'dir/b.bin', 'ünïcode.txt']);
  assert.ok(out[0].data.equals(a));
  assert.ok(out[1].data.equals(b));
});

test('refuses damaged archives and zip bombs', () => {
  const z = writeZip([{ name: 'a.txt', data: Buffer.from('hello '.repeat(100)) }]);
  const broken = Buffer.from(z);
  broken[40] ^= 0xff; // flip a byte inside the compressed data
  assert.throws(() => readZip(broken));
  assert.throws(() => readZip(Buffer.from('nope')), /Not a zip/);
  const big = writeZip([{ name: 'zeros', data: Buffer.alloc(2 * 1024 * 1024) }]);
  assert.throws(() => readZip(big, { maxEntry: 1024 * 1024 }), /too big/);
  assert.throws(() => readZip(writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))), { maxEntries: 3 }), /Too many/);
  assert.ok(zlib.deflateRawSync); // stdlib only
});
