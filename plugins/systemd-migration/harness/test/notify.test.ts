// SPDX-License-Identifier: LGPL-2.1-or-later
//
// notifySystemd() must deliver the state from the calling process itself:
// both units run with NotifyAccess=main, so a message sent by a spawned
// systemd-notify would be dropped by the manager. The test binds a datagram
// socket the way systemd does and reads what arrives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { notifySystemd, sockaddrUn } from "../src/notify.ts";

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
const MSG_DONTWAIT = 0x40;

const libc = dlopen("libc.so.6", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

function listen(path: string): number {
  const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) throw new Error("socket() failed");
  const addr = sockaddrUn(path)!;
  if (libc.symbols.bind(fd, ptr(addr), addr.length) !== 0) throw new Error("bind() failed");
  return fd;
}

function receive(fd: number): string | null {
  const buf = Buffer.alloc(4096);
  const n = Number(libc.symbols.recv(fd, ptr(buf), buf.length, MSG_DONTWAIT));
  return n < 0 ? null : buf.subarray(0, n).toString("utf8");
}

describe("notifySystemd", () => {
  let dir: string;
  let fd = -1;
  const saved = process.env.NOTIFY_SOCKET;
  beforeEach(() => {
    dir = mkdtempSync(resolve(import.meta.dir, "../.tmp/notify-"));
  });
  afterEach(() => {
    if (fd >= 0) libc.symbols.close(fd);
    fd = -1;
    if (saved === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("does nothing without NOTIFY_SOCKET", () => {
    delete process.env.NOTIFY_SOCKET;
    expect(notifySystemd("READY=1")).toBe(false);
  });

  test("delivers the state to the socket from this process", () => {
    const path = join(dir, "notify");
    fd = listen(path);
    process.env.NOTIFY_SOCKET = path;
    expect(notifySystemd("READY=1")).toBe(true);
    expect(receive(fd)).toBe("READY=1");
    expect(notifySystemd("STOPPING=1")).toBe(true);
    expect(receive(fd)).toBe("STOPPING=1");
  });

  test("reports failure when nobody listens", () => {
    process.env.NOTIFY_SOCKET = join(dir, "missing");
    expect(notifySystemd("READY=1")).toBe(false);
  });
});

describe("sockaddrUn", () => {
  test("rejects empty and over-long paths", () => {
    expect(sockaddrUn("")).toBeNull();
    expect(sockaddrUn("/" + "x".repeat(108))).toBeNull();
  });
  test("encodes abstract names with a leading NUL", () => {
    const addr = sockaddrUn("@systemd/notify")!;
    expect(addr.readUInt16LE(0)).toBe(1);
    expect(addr[2]).toBe(0);
    expect(addr.subarray(3, 17).toString()).toBe("systemd/notify");
  });
});
