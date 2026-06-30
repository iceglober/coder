// Per-process-group resource sampling. The host runner spawns each command detached (its own
// process group), so a session that tracks the pgid of its running command can ask here for that
// whole tree's CPU% + memory — which is how the TUI shows "tab 2's test suite is at 180% CPU, 4 GB"
// and you can see which session is eating the machine. Host only (a docker command's processes live
// in the container's namespace — `docker stats` would be the equivalent, later).

export interface Usage {
  /** Summed %CPU across the process group (can exceed 100 on multi-core). */
  cpu: number;
  /** Resident memory across the group, bytes. */
  rss: number;
}

/**
 * One `ps` sample, aggregated by process group. Returns usage for each requested pgid (0/0 when the
 * group has no live processes). One spawn per call regardless of how many pgids — cheap to poll.
 */
export async function sampleByPgid(pgids: number[]): Promise<Map<number, Usage>> {
  const want = new Set(pgids);
  const out = new Map<number, Usage>();
  for (const p of pgids) out.set(p, { cpu: 0, rss: 0 });
  if (!want.size) return out;
  try {
    // BSD + GNU ps both accept `-axo col=` (trailing `=` suppresses the header). rss is in KiB.
    const proc = Bun.spawn({ cmd: ["ps", "-axo", "pgid=,%cpu=,rss="], stdout: "pipe", stderr: "ignore" });
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)/);
      if (!m) continue;
      const pgid = Number(m[1]);
      if (!want.has(pgid)) continue;
      const u = out.get(pgid)!;
      u.cpu += Number(m[2]);
      u.rss += Number(m[3]) * 1024;
    }
  } catch {
    // ps missing / unsupported — return zeros rather than break the UI
  }
  return out;
}

/** Human-readable bytes for the status bar (e.g. "4.2 GB", "512 MB"). */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)}MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)}KB`;
  return `${bytes}B`;
}
