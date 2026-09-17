declare function hash(data: Uint8Array | string): Uint8Array;
declare namespace hash {
  function hmac(key: Uint8Array | string, data: Uint8Array | string): Uint8Array;
  const digestLength: number;
  const blockSize: number;
}
export = hash;
