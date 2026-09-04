'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Confirm, Elapsed, ErrorCard, PreflightList, STAGE_AR, StageStrip, StatusPill, TopBar, api, fmtDate,
} from '../../../../ui';

type Detail = any;

const MODE_AR: Record<string, string> = {
  analyze: 'تحليل وبناء الحالات', api: 'اختبار API', web: 'اختبار الويب', full: 'اختبار كامل',
};

export default function RunView() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const router = useRouter();

  const [run, setRun] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'report' | 'results' | 'progress' | 'cases' | 'analysis' | 'log' | 'preflight'>('report');
  const [cmp, setCmp] = useState<any>(null);
  const [cmpError, setCmpError] = useState('');
  const [cmpBusy, setCmpBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try { setRun(await api<Detail>(`/api/runs/${runId}`)); }
    catch (e: any) { setError(e.message); }
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  // Poll only while the run can still change.
  const isActive = run?.status === 'running' || run?.status === 'queued';
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [isActive, load]);

  async function cancel() {
    setBusy(true); setError('');
    try {
      const j = await api<{ processStop: any }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
      const s = j.processStop;
      setMessage(
        s?.alreadyGone
          ? 'العملية كانت منتهية بالفعل؛ تم تعليم التشغيل كملغى. السجلات والأدلة محفوظة.'
          : `تم إيقاف شجرة العمليات (${s?.escalated ? 'SIGTERM ثم SIGKILL' : 'SIGTERM'}). السجلات والأدلة محفوظة.`,
      );
      setConfirmCancel(false);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function retry() {
    setBusy(true); setError('');
    try {
      const j = await api<{ run: { id: string } }>(`/api/runs/${runId}/retry`, { method: 'POST' });
      router.push(`/projects/${id}/runs/${j.run.id}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function clearFromList() {
    setBusy(true); setError('');
    try {
      await api(`/api/runs/${runId}/dismiss`, { method: 'POST', body: JSON.stringify({ dismissed: true }) });
      setConfirmClear(false);
      router.push(`/projects/${id}#history`);
    } catch (e: any) { setError(e.message); setConfirmClear(false); } finally { setBusy(false); }
  }

  async function deleteRun() {
    setBusy(true); setError('');
    try {
      await api(`/api/runs/${runId}`, { method: 'DELETE' });
      router.push(`/projects/${id}#history`);
    } catch (e: any) { setError(e.message); setConfirmDelete(false); } finally { setBusy(false); }
  }

  async function compare() {
    setCmpBusy(true); setCmp(null); setCmpError('');
    try { setCmp(await api(`/api/runs/${runId}/compare`)); }
    catch (e: any) { setCmpError(e.message); } finally { setCmpBusy(false); }
  }

  const counts = useMemo(() => {
    const res = run?.results;
    const cases = Array.isArray(res?.cases) ? res.cases : Array.isArray(res) ? res : [];
    const issues = Array.isArray(res?.issues) ? res.issues : [];
    const by = (s: string) => cases.filter((c: any) => String(c.status || '').toLowerCase().startsWith(s)).length;
    return {
      total: cases.length, passed: by('pass'), failed: by('fail'), blocked: by('block'),
      issues: issues.length,
      critical: issues.filter((i: any) => String(i.severity).toLowerCase().startsWith('crit')).length,
      evidence: run?.evidence?.length || 0,
    };
  }, [run]);

  if (!run) {
    return (
      <main className="shell">
        <TopBar />
        {error ? <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>
               : <div className="empty">جارٍ التحميل…</div>}
      </main>
    );
  }

  const finished = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';

  function tabBody() {
    switch (tab) {
      case 'report': return run.report || 'التقرير لم يُكتب بعد.';
      case 'results': return run.results ? JSON.stringify(run.results, null, 2) : 'لا توجد نتائج مُهيكلة بعد.';
      case 'progress': return run.progress?.length
        ? run.progress.map((p: any) => `${p.time || ''}  ${(p.stage || '').padEnd(26)} ${p.status || ''}  ${p.summary || p.raw || ''}`).join('\n')
        : 'لا يوجد تقدّم مُسجّل بعد.';
      case 'cases': return run.useCases ? JSON.stringify(run.useCases, null, 2) : 'لم تُولّد حالات بعد.';
      case 'analysis': return run.analysis ? JSON.stringify(run.analysis, null, 2) : 'لم يُولّد تحليل النظام بعد.';
      case 'log': return run.log || 'لا يوجد سجل بعد.';
      default: return '';
    }
  }

  return (
    <main className="shell">
      <TopBar />
      <div className="crumbs">
        <a href="/">مكتبة المشاريع</a><span className="sep">/</span>
        <a href={`/projects/${id}`} className="auto">{run.projectName || 'المشروع'}</a><span className="sep">/</span>
        <span className="mono">{String(runId).slice(0, 8)}</span>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>}

      {/* ---------------- D. Current run ---------------- */}
      <section className="panel">
        <div className="runHead">
          <div>
            <div className="panelHeader" style={{ marginBottom: 8 }}>
              <h2>{MODE_AR[run.mode] || run.mode} · {run.envId}</h2>
              <StatusPill status={run.status} />
            </div>
            <p className="muted auto">
              المرحلة الحالية: <strong>{STAGE_AR[run.stage] || run.stage}</strong>
              {run.stageDetail ? ` — ${run.stageDetail}` : ''}
            </p>
            {run.activeUseCase && <p className="muted">الحالة الجارية: <span className="mono">{run.activeUseCase}</span></p>}
            {run.scope && Object.keys(run.scope).length > 0 && (
              <div className="pillRow" style={{ marginTop: 8 }}>
                {run.scope.roles?.map((r: string) => <span className="pill role" key={`r${r}`}>دور: {r}</span>)}
                {run.scope.personas?.map((p: string) => <span className="pill" key={`p${p}`}>شخصية: {p}</span>)}
                {run.scope.features?.map((f: string) => <span className="pill auto" key={`f${f}`}>ميزة: {f}</span>)}
                {run.scope.useCaseIds?.map((u: string) => <span className="pill mono" key={`u${u}`}>{u}</span>)}
              </div>
            )}
          </div>

          <div className="actionRow" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
            {!finished && <button className="danger btn-sm" onClick={() => setConfirmCancel(true)} disabled={busy}>إيقاف / إلغاء</button>}
            {finished && (run.status === 'failed' || run.status === 'cancelled') &&
              <button className="btn-sm" onClick={retry} disabled={busy}>{busy && <span className="spinner" />}إعادة المحاولة</button>}
            {finished && run.status === 'completed' &&
              <button className="secondary btn-sm" onClick={retry} disabled={busy}>تشغيل بنفس الإعدادات</button>}
            {finished && <button className="secondary btn-sm" onClick={() => setConfirmClear(true)} disabled={busy}>إزالة من القائمة</button>}
            {finished && <button className="danger btn-sm" onClick={() => setConfirmDelete(true)} disabled={busy}>حذف السجل والأدلة</button>}
            <button className="secondary btn-sm" onClick={load} disabled={busy}>تحديث</button>
          </div>
        </div>

        {/* True pause is unsafe with a live browser session, so it is not offered. */}
        {!finished && (
          <div className="maskNote" style={{ marginTop: 10 }}>
            الإيقاف المؤقت غير مدعوم: تجميد جلسة متصفح ومصادقة حيّة يُنتج نتائج غير موثوقة.
            المتاح هو <strong>إيقاف/إلغاء</strong> ثم <strong>إعادة المحاولة</strong> بنفس الإعدادات.
          </div>
        )}

        <StageStrip stage={run.stage} status={run.status} failedAt={run.failure?.stage} />

        <div className="runMetrics">
          <div><b><Elapsed startedAt={run.startedAt} finishedAt={run.finishedAt} /></b><span>المدة</span></div>
          <div><b>{counts.total || '—'}</b><span>حالات</span></div>
          <div><b style={{ color: '#246b47' }}>{counts.passed}</b><span>ناجحة</span></div>
          <div><b style={{ color: '#9a3930' }}>{counts.failed}</b><span>فاشلة</span></div>
          <div><b>{counts.blocked}</b><span>محجوبة</span></div>
          <div><b>{counts.critical}</b><span>حرجة</span></div>
          <div><b>{counts.evidence}</b><span>دليل</span></div>
        </div>

        <dl className="kv" style={{ marginTop: 6 }}>
          <dt>بدأ</dt><dd>{fmtDate(run.startedAt)}</dd>
          <dt>انتهى</dt><dd>{fmtDate(run.finishedAt)}</dd>
          {run.exitCode !== undefined && run.exitCode !== null && <><dt>رمز الخروج</dt><dd className="mono">{run.exitCode}</dd></>}
          {run.pid && <><dt>العملية / المجموعة</dt><dd className="mono">pid {run.pid} · pgid {run.pgid}</dd></>}
          {run.retryOf && <><dt>إعادة محاولة لـ</dt><dd><a href={`/projects/${id}/runs/${run.retryOf}`} className="mono">{run.retryOf.slice(0, 8)}</a></dd></>}
          {run.launch && <><dt>أمر التشغيل</dt><dd className="mono">{run.launch.bin} {(run.launch.args || []).join(' ')}</dd></>}
          {run.launch?.model && <><dt>الموديل</dt><dd className="mono">{run.launch.model}</dd></>}
        </dl>

        {/* Immediate, human-readable failure surface. */}
        {run.status === 'failed' && (
          <ErrorCard failure={run.failure} runId={String(runId)} onRetry={retry} retrying={busy} />
        )}
        {run.status === 'cancelled' && (
          <div className="notice" style={{ background: '#eceaf3', color: '#4d4870' }}>
            أُلغي هذا التشغيل بواسطة المشغّل. كل ما أُنتج قبل الإلغاء محفوظ: السجل، الأدلة، وأي حالات أو نتائج جزئية.
          </div>
        )}
      </section>

      {/* ---------------- E. Results ---------------- */}
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panelHeader">
          <h2>النتائج والمخرجات</h2>
          <div className="actionRow" style={{ marginTop: 0 }}>
            {run.reportExists && <a className="ghostButton btn-sm" href={`/api/runs/${runId}/report`}>تنزيل التقرير</a>}
            {['results.json', 'use-cases.json', 'system-analysis.json', 'progress.ndjson', 'agent.log'].map((f) => (
              run.files?.includes(f)
                ? <a className="ghostButton btn-sm" key={f} href={`/api/runs/${runId}/artifact/${f}`}>{f}</a>
                : null
            ))}
          </div>
        </div>

        <div className="tabs">
          {([
            ['report', 'التقرير'], ['results', 'النتائج'], ['progress', 'التقدّم'],
            ['cases', 'الحالات'], ['analysis', 'بنية النظام'], ['log', 'السجل'], ['preflight', 'فحص المتطلبات'],
          ] as const).map(([k, t]) => (
            <button key={k} onClick={() => setTab(k)}
              style={tab === k ? { background: '#1f6b72', color: '#fff' } : undefined}>{t}</button>
          ))}
        </div>

        {tab === 'preflight'
          ? (run.preflight
              ? <PreflightList report={run.preflight} />
              : <div className="empty">لم يُسجّل فحص متطلبات لهذا التشغيل.</div>)
          : <pre className="log">{tabBody()}</pre>}

        {run.accountsResolved && (
          <div style={{ marginTop: 12 }}>
            <h4>الحسابات المستخدمة في هذا التشغيل</h4>
            <div className="maskNote">
              جُلبت من <span className="mono">{run.accountsResolved.url}</span> في {fmtDate(run.accountsResolved.fetchedAt)}
              {' '}— أسماء الحقول فقط، بلا أي قيمة سرّية.
            </div>
            <div className="pillRow" style={{ marginTop: 8 }}>
              {(run.accountsResolved.accounts || []).slice(0, 40).map((a: any) => (
                <span className="pill" key={a.id}><span className="mono">{a.id}</span> · {a.role}</span>
              ))}
            </div>
          </div>
        )}

        {run.evidence?.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h4>الأدلة ({run.evidence.length})</h4>
            <div className="chips evidenceLinks">
              {run.evidence.map((x: string) => (
                <a key={x} href={`/api/runs/${runId}/evidence/${encodeURIComponent(x)}`} target="_blank" rel="noreferrer">{x}</a>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---------------- compare with a previous run ---------------- */}
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panelHeader">
          <h2>مقارنة بتشغيل سابق</h2>
          <button className="secondary btn-sm" onClick={compare} disabled={cmpBusy}>
            {cmpBusy && <span className="spinner" />}مقارنة بآخر تشغيل له نتائج
          </button>
        </div>
        {cmpError && <div className="empty">{cmpError}</div>}
        {cmp && (
          <>
            <p className="muted">
              الأساس: <a href={`/projects/${id}/runs/${cmp.baseline.id}`} className="mono">{cmp.baseline.id.slice(0, 8)}</a>
              {' '}({fmtDate(cmp.baseline.createdAt)}) · الحالي: <span className="mono">{String(runId).slice(0, 8)}</span>
            </p>
            <div className="runMetrics">
              {(['passed', 'failed', 'blocked', 'total'] as const).map((k) => {
                const d = cmp.comparison.counts.delta[k];
                const good = k === 'passed' || k === 'total' ? d >= 0 : d <= 0;
                return (
                  <div key={k}>
                    <b>{cmp.comparison.counts.current[k]}</b>
                    <span>
                      {{ passed: 'ناجحة', failed: 'فاشلة', blocked: 'محجوبة', total: 'الإجمالي' }[k]}{' '}
                      <span className={`delta ${good ? 'up' : 'down'}`}>{d > 0 ? `+${d}` : d}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="compareGrid">
              <div className="compareBox bad">
                <h4>فشل جديد <em>{cmp.comparison.newlyFailing.length}</em></h4>
                <ul>{cmp.comparison.newlyFailing.slice(0, 12).map((c: any) => <li key={c.id} className="auto">{c.id} — {c.title || ''}</li>)}</ul>
              </div>
              <div className="compareBox good">
                <h4>تم إصلاحه <em>{cmp.comparison.fixed.length}</em></h4>
                <ul>{cmp.comparison.fixed.slice(0, 12).map((c: any) => <li key={c.id} className="auto">{c.id} — {c.title || ''}</li>)}</ul>
              </div>
              <div className="compareBox">
                <h4>لا يزال فاشلًا <em>{cmp.comparison.stillFailing.length}</em></h4>
                <ul>{cmp.comparison.stillFailing.slice(0, 12).map((c: any) => <li key={c.id} className="auto">{c.id} — {c.title || ''}</li>)}</ul>
              </div>
              <div className="compareBox bad">
                <h4>مشاكل جديدة <em>{cmp.comparison.newIssues.length}</em></h4>
                <ul>{cmp.comparison.newIssues.slice(0, 12).map((i: any) => <li key={i.id} className="auto">[{i.severity}] {i.title}</li>)}</ul>
              </div>
              <div className="compareBox good">
                <h4>مشاكل انتهت <em>{cmp.comparison.resolvedIssues.length}</em></h4>
                <ul>{cmp.comparison.resolvedIssues.slice(0, 12).map((i: any) => <li key={i.id} className="auto">[{i.severity}] {i.title}</li>)}</ul>
              </div>
            </div>
          </>
        )}
      </section>

      <Confirm
        open={confirmCancel}
        title="إيقاف هذا التشغيل؟"
        body={
          <>
            <p>سيتم إيقاف شجرة العمليات كاملة لهذا التشغيل فقط: المشرف، Claude Code، خادم Playwright MCP، والمتصفح.</p>
            <p className="muted">التشغيلات الأخرى لا تتأثر. السجلات والأدلة المُنتجة حتى الآن تبقى محفوظة، ولا يُحذف أي تقرير سابق.</p>
          </>
        }
        confirmLabel="إيقاف الآن" danger busy={busy}
        onConfirm={cancel} onCancel={() => setConfirmCancel(false)}
      />

      <Confirm
        open={confirmClear}
        title="إزالة هذا التشغيل من القائمة النشطة؟"
        body={
          <>
            <p>سيُخفى من القائمة النشطة فقط.</p>
            <p className="muted">التقرير والسجلات والأدلة <strong>لا تُحذف</strong>، ويظل التشغيل ظاهرًا في السجل الكامل ويمكن إرجاعه.</p>
          </>
        }
        confirmLabel="إزالة من القائمة" busy={busy}
        onConfirm={clearFromList} onCancel={() => setConfirmClear(false)}
      />

      <Confirm
        open={confirmDelete}
        title="حذف سجل هذا التشغيل نهائيًا؟"
        body={
          <>
            <p>سيُحذف التقرير والسجلات والحالات وكل صور الأدلة لهذا التشغيل.</p>
            <p className="muted">للإخفاء فقط بدون حذف، استخدم «إزالة من القائمة».</p>
          </>
        }
        warn="هذا إجراء نهائي لا يمكن التراجع عنه."
        confirmLabel="حذف نهائيًا" danger busy={busy}
        onConfirm={deleteRun} onCancel={() => setConfirmDelete(false)}
      />
    </main>
  );
}
