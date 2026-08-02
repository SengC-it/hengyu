import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { crc32, parseKlineArchive, unzipSingle } from '../src/research/archive.mjs';

function zipSingle(text, overrideCrc) {
  const payload = Buffer.from(text);
  const compressed = deflateRawSync(payload);
  const name = Buffer.from('data.csv');
  const crc = overrideCrc ?? crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const centralOffset = local.length + name.length + compressed.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, eocd]);
}

test('ZIP reader verifies CRC-32', () => {
  const valid = zipSingle('hello\n');
  assert.equal(unzipSingle(valid).toString(), 'hello\n');
  assert.throws(() => unzipSingle(zipSingle('hello\n', 123)), /CRC-32 mismatch/);
});

test('strict kline parser rejects duplicate timestamps', () => {
  const row = '0,100,101,99,100,1,299999,100,1,0.5,50,0';
  const archive = zipSingle(`open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${row}\n${row}\n`);
  assert.throws(() => parseKlineArchive(archive, 'TESTUSDT', 'contract'), /duplicate open time/);
});
