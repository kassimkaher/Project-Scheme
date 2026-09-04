'use client';

import { useEffect, useState } from 'react';

export const STATUS_AR: Record<string, string> = {
  queued: 'في الانتظار', running: 'قيد التشغيل', completed: 'مكتمل',
  failed: 'فاشل', cancelled: 'ملغى',
};

/** Ordered stages shown in the strip. Terminal states are rendered separately. */
export const STAGE_FLOW = [
  'preparing', 'preflight', 'reading_config', 'fetching_openapi', 'resolving_accounts',
  'starting_claude', 'generating_system_analysis', 'generating_use_cases',
  'starting_browser', 'api_testing', 'web_testing', 'collecting_evidence', 'generating_report',
] as const;

export const STAGE_AR: Record<string, string> = {
  queued: 'في الانتظار',
  preparing: 'تحضير',
  preflight: 'فحص المتطلبات',
  reading_config: 'قراءة التعريف',
  fetching_openapi: 'جلب OpenAPI',
  resolving_accounts: 'تحضير الحسابات',
  starting_claude: 'تشغيل Claude Code',
  generating_system_analysis: 'تحليل النظام',
  generating_use_cases: 'توليد الحالات',
  starting_browser: 'تشغيل المتصفح',
  api_testing: 'اختبار API',
  web_testing: 'اختبار الويب',
  collecting_evidence: 'جمع الأدلة',
  generating_report: 'كتابة التقرير',
  completed: 'مكتمل',
  failed: 'فاشل',
  cancelled: 'ملغى',
};

export function fmtDate(v?: string) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return v; }
}

export function fmtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Live elapsed time for an active run; frozen once the run ends. */
export function Elapsed({ startedAt, finishedAt }: { startedAt?: string; finishedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finishedAt || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, finishedAt]);
  if (!startedAt) return <span className="elapsed">—</span>;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return <span className="elapsed">{fmtDuration(end - new Date(startedAt).getTime())}</span>;
}

export function StatusPill({ status }: { status?: string }) {
  const s = status || 'queued';
  return <span className={`status ${s}`}>{STATUS_AR[s] || s}</span>;
}

/**
 * Marks progress through the pipeline. A terminal run reports `stage: "failed"`,
 * which is not a position in the flow, so the strip falls back to the stage the
 * failure was actually attributed to — otherwise nothing would be highlighted and
 * the reader could not see where the run stopped.
 */
export function StageStrip({
  stage, status, failedAt,
}: { stage?: string; status?: string; failedAt?: string }) {
  const terminal = status === 'failed' || status === 'cancelled';
  const marker = STAGE_FLOW.includes(stage as never) ? stage : failedAt;
  const idx = STAGE_FLOW.indexOf(marker as never);
  return (
    <div className="stageStrip">
      {STAGE_FLOW.map((s, i) => {
        let cls = 'st';
        if (status === 'completed') cls += ' done';
        else if (idx >= 0 && i < idx) cls += ' done';
        else if (idx >= 0 && i === idx) cls += terminal ? ' bad' : ' now';
        return <span key={s} className={cls}>{STAGE_AR[s]}</span>;
      })}
      {terminal && <span className="st bad">{STAGE_AR[status === 'cancelled' ? 'cancelled' : 'failed']}</span>}
      {status === 'completed' && <span className="st done">{STAGE_AR.completed}</span>}
    </div>
  );
}

const GATE_AR: Record<string, string> = {
  claudeStarted: 'Claude Code بدأ',
  browserStarted: 'المتصفح اتصل',
  openapiFetched: 'OpenAPI متاح',
  accountsResolved: 'الحسابات جاهزة',
  outputWritable: 'مجلد الإخراج قابل للكتابة',
};

/**
 * The failure surface. Everything needed to understand a failure without opening
 * a file: stage, reason, exit code, timestamp, which startup gates passed, and
 * bounded stdout/stderr tails behind a disclosure.
 */
export function ErrorCard({
  failure, runId, onRetry, retrying,
}: {
  failure: any; runId: string; onRetry?: () => void; retrying?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!failure) return null;

  const copyText = [
    `run: ${runId}`,
    `stage: ${failure.stage} (${STAGE_AR[failure.stage] || failure.stage})`,
    `message: ${failure.message}`,
    failure.detail ? `detail: ${failure.detail}` : '',
    `exitCode: ${failure.exitCode ?? '—'}`,
    failure.signal ? `signal: ${failure.signal}` : '',
    `occurredAt: ${failure.occurredAt}`,
    failure.stderrTail ? `\n--- stderr tail ---\n${failure.stderrTail}` : '',
    failure.stdoutTail ? `\n--- stdout tail ---\n${failure.stdoutTail}` : '',
  ].filter(Boolean).join('\n');

  return (
    <div className="errorCard">
      <h3>فشل التشغيل — {STAGE_AR[failure.stage] || failure.stage}</h3>
      <div className="why auto">{failure.message}</div>
      {failure.detail && <div className="why auto" style={{ marginTop: 8, opacity: .9 }}>{failure.detail}</div>}

      <div className="facts">
        <div><b>المرحلة</b><span>{STAGE_AR[failure.stage] || failure.stage}</span></div>
        <div><b>رمز الخروج</b><span className="mono">{failure.exitCode ?? '—'}</span></div>
        {failure.signal && <div><b>الإشارة</b><span className="mono">{failure.signal}</span></div>}
        <div><b>الوقت</b><span>{fmtDate(failure.occurredAt)}</span></div>
        <div><b>قابل للإعادة</b><span>{failure.retryable ? 'نعم' : 'لا'}</span></div>
      </div>

      {failure.observed && (
        <div className="gates">
          {Object.entries(failure.observed).map(([k, v]) => (
            <span key={k} className={`gate ${v === true ? 'ok' : v === false ? 'no' : 'unknown'}`}>
              {v === true ? '✓' : v === false ? '✗' : '?'} {GATE_AR[k] || k}
            </span>
          ))}
        </div>
      )}

      <details>
        <summary>تفاصيل الخطأ الخام (stderr / stdout)</summary>
        {failure.stderrTail
          ? <><div className="maskNote">stderr — آخر الأسطر، بعد إزالة أي بيانات سرية</div>
              <pre className="log">{failure.stderrTail}</pre></>
          : <p className="muted">لا يوجد stderr مُسجّل.</p>}
        {failure.stdoutTail
          ? <><div className="maskNote">stdout — آخر الأسطر، بعد إزالة أي بيانات سرية</div>
              <pre className="log">{failure.stdoutTail}</pre></>
          : null}
        <div className="row">
          <a className="ghostButton btn-sm" href={`/api/runs/${runId}/artifact/agent.log`}>تنزيل السجل الكامل</a>
          <a className="ghostButton btn-sm" href={`/api/runs/${runId}/artifact/run.json`}>تنزيل سجل التشغيل</a>
        </div>
      </details>

      <div className="row">
        {onRetry && (
          <button className="btn-sm" onClick={onRetry} disabled={retrying}>
            {retrying && <span className="spinner" />}إعادة المحاولة (تشغيل جديد)
          </button>
        )}
        <button
          className="secondary btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(copyText).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }).catch(() => {});
          }}
        >{copied ? 'تم النسخ ✓' : 'نسخ الخطأ'}</button>
      </div>
    </div>
  );
}

export function PreflightList({ report }: { report: any }) {
  if (!report) return null;
  const mark = (s: string) => (s === 'pass' ? '✓' : s === 'fail' ? '✗' : s === 'warn' ? '!' : '–');
  return (
    <div className="checkList">
      {report.checks.map((c: any) => (
        <div key={c.id} className={`checkItem ${c.status}`}>
          <span className="mk">{mark(c.status)}</span>
          <div>
            <strong>{c.label}{c.required ? '' : ' (اختياري)'}</strong>
            {c.detail && <small className="auto">{c.detail}</small>}
            {c.fix && c.status !== 'pass' && <span className="fix">الحل: {c.fix}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Confirm({
  open, title, body, warn, confirmLabel, danger, busy, onConfirm, onCancel,
}: {
  open: boolean; title: string; body: React.ReactNode; warn?: string;
  confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div>{body}</div>
        {warn && <div className="warnBox">{warn}</div>}
        <div className="row">
          <button className="secondary" onClick={onCancel} disabled={busy}>إلغاء</button>
          <button className={danger ? 'danger' : ''} onClick={onConfirm} disabled={busy}>
            {busy && <span className="spinner" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TopBar({ active }: { active?: 'library' | 'wizard' }) {
  return (
    <div className="topbar">
      <div className="brand">
        <strong>AI QA Orchestrator</strong>
        <span>مختبر QA مستقل للويب والـ API</span>
      </div>
      <nav>
        <a href="/" className={active === 'library' ? 'active' : ''}>مكتبة المشاريع</a>
        <a href="/wizard" className={active === 'wizard' ? 'active' : ''}>إنشاء تعريف</a>
        <a href="/api/example">تنزيل مثال</a>
      </nav>
    </div>
  );
}

/** Small fetch helper that surfaces the API's error message rather than a status code. */
export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers || {}) } : init?.headers,
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const err: any = new Error(body?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}
