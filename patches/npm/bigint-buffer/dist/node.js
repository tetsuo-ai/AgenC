'use strict';

Object.defineProperty(exports, "__esModule", { value: true });
exports.toBufferBE = exports.toBufferLE = exports.toBigIntBE = exports.toBigIntLE = void 0;

function assertBuffer(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('Expected a Buffer');
  }
}

function assertWidth(width) {
  if (!Number.isInteger(width) || width < 0) {
    throw new RangeError('Expected width to be a non-negative integer');
  }
}

function toBigIntLE(buf) {
  assertBuffer(buf);
  if (buf.length === 0) {
    return BigInt(0);
  }
  const reversed = Buffer.from(buf);
  reversed.reverse();
  return BigInt(`0x${reversed.toString('hex')}`);
}
exports.toBigIntLE = toBigIntLE;

function toBigIntBE(buf) {
  assertBuffer(buf);
  if (buf.length === 0) {
    return BigInt(0);
  }
  return BigInt(`0x${buf.toString('hex')}`);
}
exports.toBigIntBE = toBigIntBE;

function toBufferBE(num, width) {
  assertWidth(width);
  const hex = num.toString(16);
  return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
}
exports.toBufferBE = toBufferBE;

function toBufferLE(num, width) {
  const buffer = toBufferBE(num, width);
  buffer.reverse();
  return buffer;
}
exports.toBufferLE = toBufferLE;
