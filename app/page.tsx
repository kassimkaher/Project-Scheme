'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Confirm, StatusPill, TopBar, api, fmtDate } from './ui';

type ProjectSummary = {
  id: string; name: string; description?: string;
  environments: number; accounts: number; webApps: number; hasAccountCatalog: boolean;
  createdAt: string; updatedAt: string; lastOpenedAt?: string; lastRunAt?: string;
  runCount: number; latestRunId?: string; latestRunStatus?: string;
};
type Run = { id: string; projectId: string; projectName: string; mode: string; status: string; stage: string; createdAt: string };
type MissingProject = { id: string; name: string; createdAt: string; sourceFilename?: string };

type Conflict = {
  match: { id: string; name: string; runCount: number; lastRunAt?: string; matchedOn: string };
  incoming: { name: string; environments: number; accounts: number; webApps: number };
};

/**
 * The project library is the entry point. It starts empty and stays empty until
 * the user imports a definition — nothing is seeded, auto-loaded or auto-selected.
 */
export default function Library() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [missing, setMissing] = useState<MissingProject[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [raw, setRaw] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [updateTarget, setUpdateTarget] = useState<ProjectSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ projects: ProjectSummary[]; missing?: MissingProject[] }>('/api/projects'),
        api<{ runs: Run[] }>('/api/runs'),
      ]);
      setProjects(p.projects);
      setMissing(p.missing || []);
      setRuns(r.runs.filter((x) => x.status === 'running' || x.status === 'queued'));
    } catch (e: any) {
      setError(e.message);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onFile(file?: File) {
    if (!file) return;
    setRaw(await file.text());
    setFilename(file.name);
    setShowImport(true);
    setError(''); setMessage('');
  }

  async function loadExampleIntoEditor() {
    const res = await fetch('/api/example');
    setRaw(await res.text());
    setFilename('qa-system.example.md');
    setShowImport(true);
  }

  async function doImport(onConflictMode: 'ask' | 'update' | 'copy', targetProjectId?: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      const body = JSON.stringify({ raw, filename, onConflict: onConflictMode, targetProjectId });
      const j = await api<{ outcome: string; project: { id: string; name: string } }>(
        '/api/projects/import', { method: 'POST', body },
      );
      setConflict(null); setUpdateTarget(null);
      const label = j.outcome === 'updated' ? 'تم تحديث المشروع'
        : j.outcome === 'copied' ? 'تم إنشاء نسخة جديدة' : 'تم استيراد المشروع';
      setMessage(`${label}: ${j.project.name}. الحسابات مُشفّرة محليًا.`);
      setShowImport(false); setRaw(''); setFilename(undefined);
      await refresh();
    } catch (e: any) {
      if (e.status === 409 && e.body?.outcome === 'conflict') {
        setConflict({ match: e.body.match, incoming: e.body.incoming });
      } else {
        setError(e.message);
      }
    } finally { setBusy(false); }
  }

  async function duplicate(p: ProjectSummary) {
    setBusy(true); setError('');
    try {
      await api(`/api/projects/${p.id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(`تم إنشاء نسخة من "${p.name}".`);
      await refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true); setError('');
    try {
      const j = await api<{ deleted: { name: string; runsRemoved: number } }>(
        `/api/projects/${deleteTarget.id}`, { method: 'DELETE' },
      );
      setMessage(`تم حذف "${j.deleted.name}" مع ${j.deleted.runsRemoved} تشغيل وكل الأدلة والأسرار.`);
      setDeleteTarget(null);
      await refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const loading = projects === null;
  const isEmpty = !loading && projects.length === 0;

  return (
    <main className="shell">
      <TopBar active="library" />

      {runs.length > 0 && (
        <div className="notice">
          <strong>تشغيل نشط الآن:</strong>{' '}
          {runs.map((r) => (
            <a key={r.id} href={`/projects/${r.projectId}/runs/${r.id}`} style={{ marginInlineEnd: 10 }}>
              {r.projectName} · {r.mode} · {r.stage}
            </a>
          ))}
        </div>
      )}

      {/* Recorded projects whose data is gone. Reporting this beats listing fewer
          projects and letting the user assume they were never imported. */}
      {missing.length > 0 && (
        <div className="notice" style={{ background: '#fff3cf', color: '#7e6115' }}>
          <strong>تنبيه:</strong> {missing.length} مشروع مُسجّل لكن بياناته غير موجودة على القرص:{' '}
          {missing.map((m) => (
            <span key={m.id} className="mono" style={{ marginInlineEnd: 8 }}>
              {m.name}{m.sourceFilename ? ` (${m.sourceFilename})` : ''}
            </span>
          ))}
          . أُنشئت في {missing.map((m) => fmtDate(m.createdAt)).join('، ')}.
          {' '}أعد استيراد ملف التعريف لاستعادة المشروع — سجل التشغيلات السابق لا يمكن استرجاعه.
        </div>
      )}

      {message && <div className="notice">{message}</div>}
      {error && <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>}

      {loading && <div className="empty">جارٍ التحميل…</div>}

      {isEmpty && !showImport && (
        <div className="emptyState">
          <div className="mark">◦</div>
          <h2>لا يوجد مشروع QA محمّل بعد</h2>
          <p>
            هذه الأداة عامة وتعمل مع أي موقع أو API. ابدأ باستيراد ملف تعريف QA خاص بنظامك،
            أو أنشئ واحدًا بالنموذج التفاعلي. لا يوجد أي مشروع أو حساب مُعرّف مسبقًا داخل الأداة.
          </p>
          <div className="row">
            <button onClick={() => setShowImport(true)}>استيراد تعريف QA</button>
            <a className="ghostButton" href="/wizard">إنشاء بالنموذج</a>
            <a className="ghostButton" href="/api/example">تنزيل مثال</a>
          </div>
        </div>
      )}

      {!isEmpty && !loading && (
        <>
          <div className="sectionTitle">
            <h2>مكتبة المشاريع <span className="badge">{projects.length}</span></h2>
            <div className="row" style={{ marginTop: 0 }}>
              <button onClick={() => setShowImport((v) => !v)}>استيراد تعريف QA</button>
              <a className="ghostButton" href="/wizard">إنشاء بالنموذج</a>
            </div>
          </div>

          <div className="libGrid">
            {projects.map((p) => (
              <article className="projectTile" key={p.id}>
                <div className="tileHead">
                  <h3 className="auto">{p.name}</h3>
                  {p.latestRunStatus && <StatusPill status={p.latestRunStatus} />}
                </div>
                {p.description && <p className="desc auto">{p.description}</p>}

                <div className="statRow">
                  <div><b>{p.environments}</b><span>بيئة</span></div>
                  {/* A project with no static accounts resolves its personas live,
                      so "0" would read as misconfigured rather than intentional. */}
                  <div
                    title={p.accounts === 0 && p.hasAccountCatalog
                      ? 'الشخصيات تُجلب من كتالوج حيّ عند كل تشغيل'
                      : `${p.accounts} حساب معرّف في الملف`}>
                    <b>{p.accounts === 0 && p.hasAccountCatalog ? 'حيّ' : p.accounts}</b>
                    <span>{p.accounts === 0 && p.hasAccountCatalog ? 'حسابات' : 'حساب'}</span>
                  </div>
                  <div><b>{p.webApps}</b><span>تطبيق ويب</span></div>
                  <div><b>{p.runCount}</b><span>تشغيل</span></div>
                </div>

                <div className="tileMeta">
                  <span>آخر تشغيل: {fmtDate(p.lastRunAt)}</span>
                  <span>آخر فتح: {fmtDate(p.lastOpenedAt)}</span>
                  {p.hasAccountCatalog && <span className="pill role" style={{ alignSelf: 'start' }}>حسابات حيّة من كتالوج</span>}
                </div>

                <div className="actionRow">
                  <a className="ghostButton btn-sm" href={`/projects/${p.id}`} style={{ background: '#1f6b72', color: '#fff' }}>فتح</a>
                  <a className="ghostButton btn-sm" href={`/projects/${p.id}#run`}>تشغيل QA</a>
                  <a className="ghostButton btn-sm" href={`/projects/${p.id}#history`}>سجل التشغيلات</a>
                  <a className="ghostButton btn-sm" href={`/projects/${p.id}#edit`}>تعديل التعريف</a>
                  <button className="secondary btn-sm" onClick={() => { setUpdateTarget(p); setShowImport(true); }}>
                    استيراد تعريف محدّث
                  </button>
                  <button className="secondary btn-sm" onClick={() => duplicate(p)} disabled={busy}>نسخ</button>
                  <button className="danger btn-sm" onClick={() => setDeleteTarget(p)}>حذف</button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {showImport && (
        <article className="panel" style={{ marginTop: 18 }}>
          <div className="panelHeader">
            <h2>{updateTarget ? `استيراد تعريف محدّث لـ "${updateTarget.name}"` : 'استيراد تعريف QA'}</h2>
            <span className="badge">Markdown / JSON</span>
          </div>
          <p className="muted">
            الملف يحتوي البيئات، روابط الـ API والويب، وحسابات QA (أو رابط كتالوج حسابات حيّ).
            قيم الحسابات تُشفّر محليًا بـ AES-256-GCM ولا تظهر في الواجهة أبدًا.
          </p>
          <label className="upload">
            اختيار ملف
            <input ref={fileRef} type="file" accept=".md,.json,.txt,.yaml,.yml"
              onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {filename && <div className="maskNote">الملف: <span className="mono">{filename}</span></div>}
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="ألصق ملف تعريف QA هنا…" />
          <div className="row">
            <button onClick={() => doImport(updateTarget ? 'update' : 'ask', updateTarget?.id)}
              disabled={busy || !raw.trim()}>
              {busy && <span className="spinner" />}{updateTarget ? 'تحديث المشروع' : 'استيراد'}
            </button>
            <button className="secondary" onClick={loadExampleIntoEditor} disabled={busy}>تحميل المثال في المحرر</button>
            <button className="secondary" onClick={() => { setShowImport(false); setUpdateTarget(null); setRaw(''); setFilename(undefined); }}>
              إلغاء
            </button>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            المثال قالب فارغ للتوضيح فقط — لا يُستورد تلقائيًا ولا يظهر كمشروع نشط حتى تستورده بنفسك.
          </p>
        </article>
      )}

      {/* Re-import of a known definition offers three explicit choices, never a silent duplicate. */}
      {conflict && (
        <div className="backdrop" onClick={() => setConflict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>هذا المشروع موجود مسبقًا</h3>
            <p>
              التعريف المستورد يطابق مشروعًا محفوظًا:{' '}
              <strong className="auto">{conflict.match.name}</strong>{' '}
              (المطابقة على:{' '}
              {conflict.match.matchedOn === 'declared projectId' ? 'projectId معلن' : 'اسم النظام + روابط المصادر'}).
            </p>
            <p className="muted">
              للمشروع الحالي {conflict.match.runCount} تشغيل محفوظ، آخرها {fmtDate(conflict.match.lastRunAt)}.
            </p>
            <div className="warnBox" style={{ background: '#f7f3e9', borderColor: '#e5dfd2', color: '#4d5754' }}>
              <strong>تحديث</strong> يستبدل التعريف ويحفظ سجل التشغيلات.<br />
              <strong>نسخة جديدة</strong> ينشئ مشروعًا مستقلًا بسجل فارغ.
            </div>
            <div className="row">
              <button className="secondary" onClick={() => setConflict(null)} disabled={busy}>إلغاء</button>
              <button className="secondary" onClick={() => doImport('copy')} disabled={busy}>
                {busy && <span className="spinner" />}استيراد كنسخة جديدة
              </button>
              <button onClick={() => doImport('update')} disabled={busy}>
                {busy && <span className="spinner" />}تحديث المشروع الحالي
              </button>
            </div>
          </div>
        </div>
      )}

      <Confirm
        open={Boolean(deleteTarget)}
        title={`حذف "${deleteTarget?.name || ''}"؟`}
        body={
          <>
            <p>سيُحذف تعريف المشروع، وحساباته المشفّرة، وكل تشغيلاته وتقاريره وأدلته.</p>
            <p className="muted">
              {deleteTarget?.runCount || 0} تشغيل و{deleteTarget?.accounts || 0} حساب سيُحذفون نهائيًا.
            </p>
          </>
        }
        warn="هذا إجراء نهائي لا يمكن التراجع عنه."
        confirmLabel="حذف نهائيًا"
        danger busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <footer>الإصدار الأول: ويب + API. الموبايل لاحقًا.</footer>
    </main>
  );
}
