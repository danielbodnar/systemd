// SPDX-License-Identifier: LGPL-2.1-or-later

/** Best-effort sd_notify over NOTIFY_SOCKET so Type=notify units see readiness. */
export function notifySystemd(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    const proc = Bun.spawn(["systemd-notify", state], { stdout: "ignore", stderr: "ignore" });
    void proc.exited;
  } catch {
    // systemd-notify absent; readiness falls back to Type=exec semantics.
  }
}
