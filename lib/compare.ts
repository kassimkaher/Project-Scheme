import type { ResultCase, ResultIssue, RunResults } from '@/types/qa';

/**
 * Reads a results.json that the QA agent wrote. The prompt pins an exact schema,
 * but a model can still drift, so this accepts the common shapes rather than
 * throwing away a whole run's results over a wrapper key.
 */
export function readResults(payload: any): RunResults {
  if (!payload || typeof payload !== 'object') return { cases: [], issues: [] };

  const caseSource =
    Array.isArray(payload) ? payload
    : Array.isArray(payload.cases) ? payload.cases
    : Array.isArray(payload.results) ? payload.results
    : Array.isArray(payload.useCases) ? payload.useCases
    : Array.isArray(payload.testCases) ? payload.testCases
    : [];

  const issueSource =
    Array.isArray(payload.issues) ? payload.issues
    : Array.isArray(payload.defects) ? payload.defects
    : Array.isArray(payload.findings) ? payload.findings
    : [];

  const cases: ResultCase[] = caseSource
    .filter((c: any) => c && typeof c === 'object')
    .map((c: any, i: number) => ({
      id: String(c.id ?? c.useCaseId ?? c.caseId ?? `case-${i + 1}`),
      title: c.title ?? c.name ?? undefined,
      role: c.role ?? undefined,
      feature: c.feature ?? undefined,
      status: normalizeStatus(c.status ?? c.result ?? c.outcome),
      severity: c.severity,
      notes: typeof c.notes === 'string' ? c.notes : undefined,
      evidence: Array.isArray(c.evidence) ? c.evidence.map(String) : undefined,
    }));

  const issues: ResultIssue[] = issueSource
    .filter((x: any) => x && typeof x === 'object')
    .map((x: any, i: number) => ({
      id: String(x.id ?? x.defectId ?? `issue-${i + 1}`),
      title: String(x.title ?? x.summary ?? x.name ?? `Issue ${i + 1}`),
      severity: normalizeSeverity(x.severity),
      useCaseId: x.useCaseId ?? x.caseId ?? undefined,
      role: x.role ?? undefined,
      feature: x.feature ?? undefined,
      evidence: Array.isArray(x.evidence) ? x.evidence.map(String) : undefined,
    }));

  return { cases, issues };
}

function normalizeStatus(v: any): ResultCase['status'] {
  const s = String(v ?? '').toLowerCase();
  if (['pass', 'passed', 'ok', 'success', 'green'].includes(s)) return 'passed';
  if (['fail', 'failed', 'error', 'red'].includes(s)) return 'failed';
  if (['blocked', 'block', 'error_blocked'].includes(s)) return 'blocked';
  return 'skipped';
}

function normalizeSeverity(v: any): ResultIssue['severity'] {
  const s = String(v ?? '').toLowerCase();
  if (s.startsWith('crit') || s === 'blocker' || s === 's1') return 'critical';
  if (s.startsWith('high') || s === 'major' || s === 's2') return 'high';
  if (s.startsWith('low') || s === 'minor' || s === 's4') return 'low';
  return 'medium';
}

export type ResultsSummary = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  issuesBySeverity: Partial<Record<ResultIssue['severity'], number>>;
};

export function summarizeResults(r: RunResults): ResultsSummary {
  const bySeverity: Partial<Record<ResultIssue['severity'], number>> = {};
  for (const i of r.issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
  return {
    total: r.cases.length,
    passed: r.cases.filter((c) => c.status === 'passed').length,
    failed: r.cases.filter((c) => c.status === 'failed').length,
    blocked: r.cases.filter((c) => c.status === 'blocked').length,
    issuesBySeverity: bySeverity,
  };
}

export type RunComparison = {
  baselineRunId: string;
  currentRunId: string;
  newlyFailing: ResultCase[];
  fixed: ResultCase[];
  stillFailing: ResultCase[];
  newIssues: ResultIssue[];
  resolvedIssues: ResultIssue[];
  counts: {
    baseline: ResultsSummary;
    current: ResultsSummary;
    delta: { passed: number; failed: number; blocked: number; total: number };
  };
};

/** A case matches across runs by id; falls back to a normalized title. */
function keyOf(c: { id: string; title?: string }): string {
  return c.id && !/^case-\d+$/.test(c.id)
    ? `id:${c.id}`
    : `title:${String(c.title || c.id).trim().toLowerCase()}`;
}

function issueKey(i: ResultIssue): string {
  return i.id && !/^issue-\d+$/.test(i.id)
    ? `id:${i.id}`
    : `t:${i.title.trim().toLowerCase()}|${i.severity}`;
}

export function compareRuns(
  baselineRunId: string, baseline: RunResults,
  currentRunId: string, current: RunResults,
): RunComparison {
  const baseByKey = new Map(baseline.cases.map((c) => [keyOf(c), c]));
  const curByKey = new Map(current.cases.map((c) => [keyOf(c), c]));

  const isBad = (c?: ResultCase) => Boolean(c && (c.status === 'failed' || c.status === 'blocked'));

  const newlyFailing: ResultCase[] = [];
  const stillFailing: ResultCase[] = [];
  for (const [k, c] of curByKey) {
    if (!isBad(c)) continue;
    isBad(baseByKey.get(k)) ? stillFailing.push(c) : newlyFailing.push(c);
  }

  const fixed: ResultCase[] = [];
  for (const [k, c] of baseByKey) {
    if (!isBad(c)) continue;
    const now = curByKey.get(k);
    if (now && now.status === 'passed') fixed.push(now);
  }

  const baseIssues = new Map(baseline.issues.map((i) => [issueKey(i), i]));
  const curIssues = new Map(current.issues.map((i) => [issueKey(i), i]));
  const newIssues = [...curIssues].filter(([k]) => !baseIssues.has(k)).map(([, v]) => v);
  const resolvedIssues = [...baseIssues].filter(([k]) => !curIssues.has(k)).map(([, v]) => v);

  const b = summarizeResults(baseline);
  const c = summarizeResults(current);

  return {
    baselineRunId, currentRunId,
    newlyFailing, fixed, stillFailing, newIssues, resolvedIssues,
    counts: {
      baseline: b, current: c,
      delta: {
        passed: c.passed - b.passed,
        failed: c.failed - b.failed,
        blocked: c.blocked - b.blocked,
        total: c.total - b.total,
      },
    },
  };
}
