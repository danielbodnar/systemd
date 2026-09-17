// SPDX-License-Identifier: LGPL-2.1-or-later

import { dlopen, FFIType, ptr } from "bun:ffi";

// The notification has to leave the service's main process itself: both units
// run with NotifyAccess=main, so a message sent by a child (systemd-notify,
// or anything a tool call spawned) is dropped by the manager. This is the
// sd_notify(3) wire protocol, one datagram on the AF_UNIX socket named by
// NOTIFY_SOCKET, written with libc directly because libsystemd reads the C
// environment and Bun's process.env does not propagate into it.

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0o2000000;
const MSG_NOSIGNAL = 0x4000;
const SUN_PATH_MAX = 108;

type Libc = {
  socket: (domain: number, type: number, protocol: number) => number;
  sendto: (fd: number, buf: number | bigint, len: number | bigint, flags: number, addr: number | bigint, addrlen: number) => number | bigint;
  close: (fd: number) => number;
};

let libc: Libc | null | undefined;

function loadLibc(): Libc | null {
  if (libc !== undefined) return libc;
  try {
    const lib = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      sendto: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    libc = lib.symbols as unknown as Libc;
  } catch {
    libc = null;
  }
  return libc;
}

/** struct sockaddr_un for a filesystem path or an abstract (@-prefixed) name. */
export function sockaddrUn(path: string): Buffer | null {
  const name = Buffer.from(path, "utf8");
  if (name.length === 0 || name.length >= SUN_PATH_MAX) return null;
  const addr = Buffer.alloc(2 + SUN_PATH_MAX);
  addr.writeUInt16LE(AF_UNIX, 0);
  name.copy(addr, 2);
  if (path.startsWith("@")) addr[2] = 0;
  return addr;
}

/**
 * Send a state string (READY=1, STOPPING=1, ...) to the service manager over
 * NOTIFY_SOCKET (or the socket path given, for a caller that scrubbed the
 * variable from its environment) from this process. Returns true when the whole message was
 * sent; false when there is no NOTIFY_SOCKET, when the socket cannot be
 * opened, or when the send failed. Never throws.
 */
export function notifySystemd(state: string, socketPath: string | undefined = process.env.NOTIFY_SOCKET): boolean {
  if (!socketPath) return false;
  const c = loadLibc();
  const addr = sockaddrUn(socketPath);
  if (c === null || addr === null) return false;
  const fd = c.socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return false;
  try {
    const msg = Buffer.from(state, "utf8");
    // Abstract names count their NUL prefix and nothing after the name.
    const addrlen = socketPath.startsWith("@") ? 2 + Buffer.byteLength(socketPath, "utf8") : addr.length;
    return Number(c.sendto(fd, ptr(msg), msg.length, MSG_NOSIGNAL, ptr(addr), addrlen)) === msg.length;
  } catch {
    return false;
  } finally {
    c.close(fd);
  }
}
