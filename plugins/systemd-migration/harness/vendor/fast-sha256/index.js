// SPDX-License-Identifier: LGPL-2.1-or-later
//
// fast-sha256 shim. The npm package of that name is unmaintained pure
// JavaScript; @anthropic-ai/sdk reaches it only through standardwebhooks,
// which calls `hmac(key, data)` for webhook signature checks. Node's crypto
// module provides the same primitives, so this shim delegates to it and is
// selected through the `overrides` field in the harness package.json.

"use strict";

const { createHash, createHmac } = require("node:crypto");

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string") return Buffer.from(input, "utf8");
  throw new TypeError("fast-sha256 shim: expected Uint8Array, Buffer, or string");
}

function hash(data) {
  return new Uint8Array(createHash("sha256").update(toBuffer(data)).digest());
}

function hmac(key, data) {
  return new Uint8Array(createHmac("sha256", toBuffer(key)).update(toBuffer(data)).digest());
}

module.exports = hash;
module.exports.default = hash;
module.exports.hash = hash;
module.exports.hmac = hmac;
module.exports.digestLength = 32;
module.exports.blockSize = 64;
