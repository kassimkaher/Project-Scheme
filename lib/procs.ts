import { spawnSync } from 'node:child_process';

/**
 * Process-tree control for QA runs.
 *
 * The supervisor is spawned detached, so its pid leads a new process group and
 * Claude Code plus the Playwright MCP server inherit it. Signalling the negative
 * pgid would seem to be enough — but it is not.
 *
 * Chromium puts itself in its OWN process group when it starts, and some of its
 * helpers re-parent to init. Measured on a real run: the supervisor's group held
 * 3 processes (supervisor, claude, MCP server) while 12 Chromium processes sat
 * outside it. A plain group kill therefore left a browser running after every
 * cancel.
 *
 * So cancellation walks parent/child links to build the actual descendant set
 * first, collects every process group involved, and signals all of them. The set
 * is rooted at this run's supervisor, so no other run is ever touched.
 */

export type KillOutcome = {
  attempted: boolean;
  alreadyGone: boolean;
  /** Processes found below the supervisor, including it. */
  treeSize: number;
  /** Distinct process groups signalled. */
  groups: number[];
  escalated: boolean;
  /** Pids still alive after SIGKILL, if any. */
  survivors: number[];
  error?: string;
};

export function isAlive(pid?: number | null): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but is owned by another user.
    return e?.code === 'EPERM';
  }
}

type ProcRow = { pid: number; ppid: number; pgid: number };

/** One snapshot of the process table. Taken before killing, because parent links vanish with the parent. */
function processTable(): ProcRow[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return rows;
}

/** Every process descended from rootPid, inclusive. */
export function descendants(rootPid: number, table = processTable()): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const row of table) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid)!.push(row);
  }
  const self = table.find((r) => r.pid === rootPid);
  const out: ProcRow[] = self ? [self] : [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try { process.kill(-pgid, sig); return true; } catch { return false; }
}

function signalPid(pid: number, sig: NodeJS.Signals): boolean {
  try { process.kill(pid, sig); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stops one run's process tree and nothing else. Sends SIGTERM to every group
 * and pid in the tree, waits for a clean shutdown, then SIGKILLs whatever is
 * left. Artifacts on disk are never touched.
 */
export async function killRunTree(
  opts: { pid?: number | null; pgid?: number | null; graceMs?: number },
): Promise<KillOutcome> {
  const { pid, pgid, graceMs = 4000 } = opts;
  const out: KillOutcome = {
    attempted: false, alreadyGone: false, treeSize: 0,
    groups: [], escalated: false, survivors: [],
  };

  const root = pid || pgid || null;
  if (!root) {
    out.error = 'No process id recorded for this run; nothing to stop.';
    return out;
  }
  if (!isAlive(root)) {
    out.alreadyGone = true;
    return out;
  }
  out.attempted = true;

  // Snapshot BEFORE signalling: once the parent dies its children re-parent to
  // init and the tree can no longer be reconstructed.
  const tree = descendants(root);
  const pids = tree.length ? tree.map((r) => r.pid) : [root];
  const groups = [...new Set([...(pgid ? [pgid] : []), ...tree.map((r) => r.pgid)])]
    .filter((g) => g > 1);
  out.treeSize = pids.length;
  out.groups = groups;

  for (const g of groups) signalGroup(g, 'SIGTERM');
  for (const p of pids) signalPid(p, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pids.some((p) => isAlive(p))) return out;
    await sleep(200);
  }

  const stubborn = pids.filter((p) => isAlive(p));
  if (stubborn.length) {
    out.escalated = true;
    for (const g of groups) signalGroup(g, 'SIGKILL');
    for (const p of stubborn) signalPid(p, 'SIGKILL');
    await sleep(400);
    out.survivors = pids.filter((p) => isAlive(p));
  }
  return out;
}
