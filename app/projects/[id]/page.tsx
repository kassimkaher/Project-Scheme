'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Confirm, Elapsed, PreflightList, StatusPill, TopBar, api, fmtDate,
} from '../../ui';

type Env = {
  id: string; label: string; kind: string; apiBaseUrl?: string; openapiUrl?: string;
  webApps: Array<{ id: string; label: string; url: string }>;
  accountCatalog?: { url: string; requiredRoles?: string[]; requiredPersonas?: string[] };
};
type AccountRef = {
  id: string; role: string; label?: string; loginType: string;
  credentialKeys: string[]; source?: string; tenant?: string; mfaRequired?: boolean;
  meta?: Record<string, string>;
};
type Project = {
  id: string; name: string; description?: string; sourceFilename?: string;
  fingerprint: string; declaredId?: string; migratedFrom?: string;
  createdAt: string; updatedAt: string; lastOpenedAt?: string; lastRunAt?: string;
  runCount: number;
  spec: {
    system: { name: string; description?: string };
    environments: Env[];
    accounts: AccountRef[];
    accountCatalog?: { url: string };
    documentation?: Array<{ label: string; url: string }>;
    qa?: { preferredLanguage?: string; destructiveActions?: string; notes?: string[] };
  };
};
type Run = {
  id: string; mode: string; envId: string; status: string; stage: string; stageDetail?: string;
  createdAt: string; startedAt?: string; finishedAt?: string; dismissed?: boolean;
  retryOf?: string; failure?: any; counts?: any; reportExists?: boolean;
};

const MODES = [
  { v: 'analyze', t: 'تحليل وبناء الحالات فقط', d: 'أدوار، ميزات، شجرة النظام، وحالات اختبار — بدون تنفيذ.' },
  { v: 'api', t: 'اختبار API', d: 'العقد، الصلاحيات، التحقق، والحالات السلبية.' },
  { v: 'web', t: 'اختبار الويب بالمتصفح', d: 'متصفح حقيقي، تسجيل دخول، سيناريوهات وصور.' },
  { v: 'full', t: 'اختبار كامل', d: 'التحليل والـ API والويب في تقرير واحد.' },
];

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // run launcher
  const [envId, setEnvId] = useState('');
  const [mode, setMode] = useState('analyze');
  const [accounts, setAccounts] = useState<{ accounts: AccountRef[]; roles: string[]; source?: string; catalogUrl?: string; fetchedAt?: string; error?: string } | null>(null);
  const [scopeRoles, setScopeRoles] = useState<string[]>([]);
  const [scopePersonas, setScopePersonas] = useState<string[]>([]);
  const [scopeFeatures, setScopeFeatures] = useState<string[]>([]);
  const [scopeCases, setScopeCases] = useState<string[]>([]);
  const [scopeSource, setScopeSource] = useState<{ fromRunId: string | null; features: string[]; useCases: any[] } | null>(null);
  const [pre, setPre] = useState<any>(null);
  const [preBusy, setPreBusy] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);

  // editor
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Project['spec'] | null>(null);

  // dialogs
  const [deleteRunTarget, setDeleteRunTarget] = useState<Run | null>(null);

  const load = useCallback(async (touch = false) => {
    try {
      const j = await api<{ project: Project; runs: Run[] }>(`/api/projects/${id}?touch=${touch}`);
      setProject(j.project);
      setRuns(j.runs);
      setEnvId((prev) => prev || j.project.spec.environments[0]?.id || '');
    } catch (e: any) { setError(e.message); }
  }, [id]);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    const t = setInterval(() => load(false), 5000);
    return () => clearInterval(t);
  }, [load]);

  // Personas are resolved live per environment, never read from a cached copy.
  useEffect(() => {
    if (!envId) return;
    setAccounts(null);
    api(`/api/projects/${id}/accounts?envId=${encodeURIComponent(envId)}`)
      .then(setAccounts).catch((e) => setAccounts({ accounts: [], roles: [], error: e.message }));
  }, [id, envId]);

  useEffect(() => { api(`/api/projects/${id}/scope`).then(setScopeSource).catch(() => setScopeSource(null)); }, [id]);

  const activeRun = useMemo(() => runs.find((r) => r.status === 'running' || r.status === 'queued'), [runs]);
  const visibleRuns = useMemo(() => (showAllRuns ? runs : runs.filter((r) => !r.dismissed)), [runs, showAllRuns]);
  const env = project?.spec.environments.find((e) => e.id === envId);
  const needsBrowser = mode === 'web' || mode === 'full';

  function toggle(list: string[], set: (v: string[]) => void, v: string) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  async function runPreflight() {
    setPreBusy(true); setPre(null); setError('');
    try {
      const j = await api<{ preflight: any }>(`/api/projects/${id}/preflight`, {
        method: 'POST', body: JSON.stringify({ envId, mode }),
      });
      setPre(j.preflight);
    } catch (e: any) { setError(e.message); } finally { setPreBusy(false); }
  }

  async function start() {
    setBusy(true); setError(''); setMessage('');
    const scope: any = {};
    if (scopeRoles.length) scope.roles = scopeRoles;
    if (scopePersonas.length) scope.personas = scopePersonas;
    if (scopeFeatures.length) scope.features = scopeFeatures;
    if (scopeCases.length) scope.useCaseIds = scopeCases;
    try {
      const j = await api<{ run: { id: string }; accountsResolved: number }>(`/api/projects/${id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ envId, mode, scope: Object.keys(scope).length ? scope : undefined, enforcePreflight: true }),
      });
      router.push(`/projects/${id}/runs/${j.run.id}`);
    } catch (e: any) {
      // Preflight refusals arrive with the full report so the reason is visible here.
      if (e.body?.preflight) setPre(e.body.preflight);
      setError(e.message);
      await load(false);
    } finally { setBusy(false); }
  }

  async function cancel(runId: string) {
    setBusy(true); setError('');
    try { await api(`/api/runs/${runId}/cancel`, { method: 'POST' }); setMessage('تم إلغاء التشغيل. السجلات والأدلة محفوظة.'); await load(false); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function retry(runId: string) {
    setBusy(true); setError('');
    try {
      const j = await api<{ run: { id: string } }>(`/api/runs/${runId}/retry`, { method: 'POST' });
      router.push(`/projects/${id}/runs/${j.run.id}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function dismiss(runId: string, dismissed: boolean) {
    setBusy(true); setError('');
    try {
      await api(`/api/runs/${runId}/dismiss`, { method: 'POST', body: JSON.stringify({ dismissed }) });
      setMessage(dismissed
        ? 'أُزيل التشغيل من القائمة النشطة. التقرير والأدلة والسجل محفوظة في السجل الكامل.'
        : 'أُعيد التشغيل إلى القائمة النشطة.');
      await load(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function confirmDeleteRun() {
    if (!deleteRunTarget) return;
    setBusy(true); setError('');
    try {
      await api(`/api/runs/${deleteRunTarget.id}`, { method: 'DELETE' });
      setMessage('حُذف التشغيل وكل تقاريره وأدلته نهائيًا.');
      setDeleteRunTarget(null);
      await load(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function saveEdits() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.system.name,
          description: draft.system.description,
          environments: draft.environments,
          documentation: draft.documentation,
          qa: draft.qa,
          accounts: draft.accounts.map((a) => ({
            id: a.id, role: a.role, label: a.label, loginType: a.loginType,
          })),
        }),
      });
      setMessage('تم حفظ التعديلات. قيم الحسابات السرّية لم تُلمس.');
      setEditing(false); setDraft(null);
      await load(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (!project) {
    return (
      <main className="shell">
        <TopBar />
        {error ? <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>
               : <div className="empty">جارٍ التحميل…</div>}
      </main>
    );
  }

  const spec = editing && draft ? draft : project.spec;

  return (
    <main className="shell">
      <TopBar />
      <div className="crumbs">
        <a href="/">مكتبة المشاريع</a><span className="sep">/</span>
        <span className="auto">{project.name}</span>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>}

      {/* ---------------- B. Selected project ---------------- */}
      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2 className="auto">{project.name}</h2>
            {project.description && <p className="muted auto">{project.description}</p>}
          </div>
          <div className="row" style={{ marginTop: 0 }}>
            {!editing
              ? <button className="secondary btn-sm" onClick={() => { setDraft(structuredClone(project.spec)); setEditing(true); }}>تعديل التعريف</button>
              : <>
                  <button className="btn-sm" onClick={saveEdits} disabled={busy}>{busy && <span className="spinner" />}حفظ</button>
                  <button className="secondary btn-sm" onClick={() => { setEditing(false); setDraft(null); }}>إلغاء</button>
                </>}
          </div>
        </div>

        <dl className="kv">
          <dt>عدد البيئات</dt><dd>{spec.environments.length}</dd>
          <dt>عدد الحسابات المعرّفة</dt><dd>{spec.accounts.length}</dd>
          <dt>تطبيقات الويب</dt><dd>{spec.environments.reduce((n, e) => n + e.webApps.length, 0)}</dd>
          <dt>عدد التشغيلات</dt><dd>{project.runCount}</dd>
          <dt>آخر تشغيل</dt><dd>{fmtDate(project.lastRunAt)}</dd>
          <dt>تاريخ الاستيراد</dt><dd>{fmtDate(project.createdAt)}</dd>
          {project.sourceFilename && <><dt>الملف الأصلي</dt><dd className="mono">{project.sourceFilename}</dd></>}
          {project.declaredId && <><dt>projectId المعلن</dt><dd className="mono">{project.declaredId}</dd></>}
          {project.migratedFrom && <><dt>ملاحظة</dt><dd>تم ترحيل هذا المشروع من تخزين الإصدار السابق ({project.migratedFrom}).</dd></>}
        </dl>

        {editing && draft && (
          <div className="editGrid" style={{ marginTop: 16 }}>
            <div className="editRow">
              <div className="two">
                <label>اسم النظام
                  <input className="auto" value={draft.system.name}
                    onChange={(e) => setDraft({ ...draft, system: { ...draft.system, name: e.target.value } })} /></label>
                <label>الوصف
                  <input className="auto" value={draft.system.description || ''}
                    onChange={(e) => setDraft({ ...draft, system: { ...draft.system, description: e.target.value } })} /></label>
              </div>
            </div>

            {draft.environments.map((e, i) => (
              <div className="editRow" key={e.id}>
                <div className="three">
                  <label>معرّف البيئة<input dir="ltr" value={e.id}
                    onChange={(ev) => { const envs = [...draft.environments]; envs[i] = { ...e, id: ev.target.value }; setDraft({ ...draft, environments: envs }); }} /></label>
                  <label>الاسم<input className="auto" value={e.label}
                    onChange={(ev) => { const envs = [...draft.environments]; envs[i] = { ...e, label: ev.target.value }; setDraft({ ...draft, environments: envs }); }} /></label>
                  <label>النوع
                    <select value={e.kind}
                      onChange={(ev) => { const envs = [...draft.environments]; envs[i] = { ...e, kind: ev.target.value }; setDraft({ ...draft, environments: envs }); }}>
                      {['local', 'qa', 'staging', 'production', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}
                    </select></label>
                </div>
                <div className="two">
                  <label>رابط API<input dir="ltr" value={e.apiBaseUrl || ''}
                    onChange={(ev) => { const envs = [...draft.environments]; envs[i] = { ...e, apiBaseUrl: ev.target.value || undefined }; setDraft({ ...draft, environments: envs }); }} /></label>
                  <label>رابط OpenAPI<input dir="ltr" value={e.openapiUrl || ''}
                    onChange={(ev) => { const envs = [...draft.environments]; envs[i] = { ...e, openapiUrl: ev.target.value || undefined }; setDraft({ ...draft, environments: envs }); }} /></label>
                </div>
                {e.webApps.map((w, wi) => (
                  <div className="two" key={w.id}>
                    <label>تطبيق ويب — الاسم<input className="auto" value={w.label}
                      onChange={(ev) => { const envs = [...draft.environments]; const apps = [...e.webApps]; apps[wi] = { ...w, label: ev.target.value }; envs[i] = { ...e, webApps: apps }; setDraft({ ...draft, environments: envs }); }} /></label>
                    <label>الرابط<input dir="ltr" value={w.url}
                      onChange={(ev) => { const envs = [...draft.environments]; const apps = [...e.webApps]; apps[wi] = { ...w, url: ev.target.value }; envs[i] = { ...e, webApps: apps }; setDraft({ ...draft, environments: envs }); }} /></label>
                  </div>
                ))}
                <label>رابط كتالوج الحسابات الحيّ (اختياري)
                  <input dir="ltr" value={e.accountCatalog?.url || ''}
                    onChange={(ev) => {
                      const envs = [...draft.environments];
                      envs[i] = { ...e, accountCatalog: ev.target.value ? { ...e.accountCatalog, url: ev.target.value } : undefined };
                      setDraft({ ...draft, environments: envs });
                    }} /></label>
              </div>
            ))}

            <div className="editRow">
              <strong style={{ fontSize: 13 }}>حسابات QA — البيانات الوصفية فقط</strong>
              <span className="maskNote">
                قيم كلمات المرور والرموز غير قابلة للعرض أو التعديل من الواجهة. تبقى مشفّرة، وتتغيّر فقط باستيراد تعريف محدّث.
              </span>
              {draft.accounts.length === 0 && <p className="muted">لا حسابات ثابتة — الحسابات تُجلب من الكتالوج الحيّ.</p>}
              {draft.accounts.map((a, i) => (
                <div className="three" key={a.id}>
                  <label>المعرّف<input dir="ltr" value={a.id} readOnly /></label>
                  <label>الدور<input className="auto" value={a.role}
                    onChange={(ev) => { const accs = [...draft.accounts]; accs[i] = { ...a, role: ev.target.value }; setDraft({ ...draft, accounts: accs }); }} /></label>
                  <label>الاسم<input className="auto" value={a.label || ''}
                    onChange={(ev) => { const accs = [...draft.accounts]; accs[i] = { ...a, label: ev.target.value }; setDraft({ ...draft, accounts: accs }); }} /></label>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---------------- environments / sources / personas ---------------- */}
      <section className="grid two" style={{ marginTop: 18 }}>
        <article className="panel">
          <div className="panelHeader"><h2>البيئات والمصادر</h2></div>
          {spec.environments.map((e) => (
            <div key={e.id} style={{ marginBottom: 14 }}>
              <div className="pillRow" style={{ marginBottom: 8 }}>
                <span className="pill role auto">{e.label}</span>
                <span className={`pill ${e.kind === 'production' ? 'warn' : ''}`}>{e.kind}</span>
                {e.accountCatalog && <span className="pill role">كتالوج حسابات حيّ</span>}
              </div>
              <div className="sourceList">
                <code>API: {e.apiBaseUrl || '—'}</code>
                <code>OpenAPI: {e.openapiUrl || '—'}</code>
                {e.webApps.map((w) => <code key={w.id}>{w.label}: {w.url}</code>)}
                {e.accountCatalog && <code>Accounts: {e.accountCatalog.url}</code>}
              </div>
            </div>
          ))}
          {spec.documentation?.length ? (
            <>
              <h4>مستندات مساندة</h4>
              <div className="sourceList">{spec.documentation.map((d) => <code key={d.url}>{d.label}: {d.url}</code>)}</div>
            </>
          ) : null}
        </article>

        <article className="panel">
          <div className="panelHeader">
            <h2>حسابات QA / الشخصيات</h2>
            {accounts?.source === 'catalog' && <span className="badge">من الكتالوج الحيّ</span>}
          </div>
          {!accounts && <div className="empty">جارٍ تحضير الحسابات…</div>}
          {accounts?.error && <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{accounts.error}</div>}
          {accounts && !accounts.error && (
            <>
              <div className="maskNote">
                {accounts.source === 'catalog'
                  ? `تم الجلب من ${accounts.catalogUrl} في ${fmtDate(accounts.fetchedAt)} — تُجلب من جديد قبل كل تشغيل.`
                  : 'حسابات ثابتة من التعريف المستورد.'}
                {' '}لا تُعرض أي قيم سرّية، فقط أسماء الحقول.
              </div>
              <div className="pillRow" style={{ marginTop: 10 }}>
                {accounts.roles.map((r) => (
                  <span className="pill role" key={r}>
                    {r} · {accounts.accounts.filter((a) => a.role === r).length}
                  </span>
                ))}
              </div>
              <div className="runList" style={{ marginTop: 12, maxHeight: 320, overflow: 'auto' }}>
                {accounts.accounts.map((a) => (
                  <div className="runItem" key={a.id} style={{ gridTemplateColumns: '1fr auto' }}>
                    <div className="rmain">
                      <strong className="mono">{a.id}</strong>
                      <small className="auto">
                        {a.role}{a.label ? ` · ${a.label}` : ''}
                        {a.tenant ? ` · ${a.tenant}` : ''}
                        {' · '}الحقول: {a.credentialKeys.join(', ') || '—'}
                      </small>
                    </div>
                    <div className="pillRow">
                      {a.mfaRequired && <span className="pill warn">MFA</span>}
                      <span className="pill">{a.source === 'catalog' ? 'كتالوج' : 'ثابت'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </article>
      </section>

      {/* ---------------- C. Run QA ---------------- */}
      <section className="panel runPanel" id="run" style={{ marginTop: 18 }}>
        <div className="panelHeader">
          <div><h2>تشغيل QA</h2><p className="muted">اختر البيئة ونوع الاختبار والنطاق. لا حاجة لإعادة رفع الملف.</p></div>
          {activeRun && <span className="liveDot">تشغيل نشط</span>}
        </div>

        {activeRun && (
          <div className="notice">
            هناك تشغيل نشط لهذا المشروع (<span className="mono">{activeRun.id.slice(0, 8)}</span> · {activeRun.stage}).
            {' '}<a href={`/projects/${id}/runs/${activeRun.id}`}>متابعته</a> أو
            {' '}<button className="secondary btn-sm" onClick={() => cancel(activeRun.id)} disabled={busy}>إلغاؤه</button>
            {' '}قبل بدء تشغيل جديد.
          </div>
        )}

        <div className="controls">
          <label>البيئة
            <select value={envId} onChange={(e) => { setEnvId(e.target.value); setPre(null); setScopePersonas([]); setScopeRoles([]); }}>
              {spec.environments.map((e) => <option key={e.id} value={e.id}>{e.label} · {e.kind}</option>)}
            </select></label>
          <label>نوع الاختبار
            <select value={mode} onChange={(e) => { setMode(e.target.value); setPre(null); }}>
              {MODES.map((m) => <option key={m.v} value={m.v}>{m.t}</option>)}
            </select></label>
          <button onClick={start} disabled={busy || Boolean(activeRun) || !envId}>
            {busy && <span className="spinner" />}تشغيل
          </button>
        </div>

        {env?.kind === 'production' && (
          <div className="notice" style={{ background: '#fff3cf', color: '#7e6115' }}>
            هذه بيئة <strong>إنتاج</strong>. سيُمنع الوكيل من الحذف أو التعديل الجماعي أو اختبار الحمل أو أي محاولة استغلال،
            وسيلتزم بسياسة <span className="mono">{spec.qa?.destructiveActions || 'forbid'}</span>.
          </div>
        )}

        {/* scope */}
        <div className="scopeBox">
          <strong style={{ fontSize: 13 }}>نطاق التشغيل (اختياري — الفراغ يعني كل شيء)</strong>

          {accounts && accounts.roles.length > 0 && (
            <>
              <p className="muted" style={{ margin: '10px 0 6px' }}>الأدوار</p>
              <div className="pillRow">
                {accounts.roles.map((r) => (
                  <label key={r}>
                    <input type="checkbox" checked={scopeRoles.includes(r)}
                      onChange={() => toggle(scopeRoles, setScopeRoles, r)} />{r}
                  </label>
                ))}
              </div>
            </>
          )}

          {accounts && accounts.accounts.length > 0 && (
            <>
              <p className="muted" style={{ margin: '10px 0 6px' }}>
                شخصيات محددة {scopeRoles.length ? '(يتجاوز اختيار الأدوار)' : ''}
              </p>
              <div className="pillRow" style={{ maxHeight: 120, overflow: 'auto' }}>
                {accounts.accounts.map((a) => (
                  <label key={a.id}>
                    <input type="checkbox" checked={scopePersonas.includes(a.id)}
                      onChange={() => toggle(scopePersonas, setScopePersonas, a.id)} />
                    <span className="mono">{a.id}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          {scopeSource?.features?.length ? (
            <>
              <p className="muted" style={{ margin: '10px 0 6px' }}>
                الميزات (من حالات تشغيل سابق <span className="mono">{scopeSource.fromRunId?.slice(0, 8)}</span>)
              </p>
              <div className="pillRow">
                {scopeSource.features.map((f) => (
                  <label key={f}>
                    <input type="checkbox" checked={scopeFeatures.includes(f)}
                      onChange={() => toggle(scopeFeatures, setScopeFeatures, f)} /><span className="auto">{f}</span>
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {scopeSource?.useCases?.length ? (
            <>
              <p className="muted" style={{ margin: '10px 0 6px' }}>حالات محددة ({scopeSource.useCases.length} متاحة)</p>
              <div className="pillRow" style={{ maxHeight: 130, overflow: 'auto' }}>
                {scopeSource.useCases.map((u: any) => (
                  <label key={u.id} title={u.title}>
                    <input type="checkbox" checked={scopeCases.includes(u.id)}
                      onChange={() => toggle(scopeCases, setScopeCases, u.id)} />
                    <span className="mono">{u.id}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p className="muted" style={{ marginTop: 10 }}>
              لا توجد حالات مولّدة بعد. شغّل «تحليل وبناء الحالات» أولًا لتتمكن من تحديد ميزات أو حالات بعينها.
            </p>
          )}
        </div>

        <div className="modeCards">
          {MODES.map((m) => (
            <div key={m.v} style={mode === m.v ? { borderColor: '#1f6b72', background: '#f1f8f5' } : undefined}>
              <b>{m.t}</b><span>{m.d}</span>
            </div>
          ))}
        </div>

        <div className="row">
          <button className="secondary" onClick={runPreflight} disabled={preBusy}>
            {preBusy && <span className="spinner" />}فحص المتطلبات قبل التشغيل
          </button>
          {needsBrowser && <span className="maskNote">وضع الويب يتطلب Playwright MCP ونسخة Chromium مثبّتة.</span>}
        </div>
        {pre && (
          <div style={{ marginTop: 12 }}>
            <div className={`notice ${pre.ok ? '' : ''}`} style={pre.ok ? undefined : { background: '#fef6f4', color: '#8f342b' }}>
              {pre.ok ? 'كل المتطلبات المطلوبة متوفرة.' : 'هناك متطلب مطلوب غير متوفر — سيُرفض التشغيل قبل أن يبدأ.'}
            </div>
            <PreflightList report={pre} />
          </div>
        )}
      </section>

      {/* ---------------- run history ---------------- */}
      <section className="panel" id="history" style={{ marginTop: 18 }}>
        <div className="panelHeader">
          <h2>سجل التشغيلات <span className="badge">{runs.length}</span></h2>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showAllRuns} onChange={(e) => setShowAllRuns(e.target.checked)} />
            إظهار المُزالة من القائمة النشطة
          </label>
        </div>

        {visibleRuns.length === 0 ? (
          <div className="empty">لا يوجد تشغيل بعد لهذا المشروع.</div>
        ) : (
          <div className="runList">
            {visibleRuns.map((r) => (
              <div className={`runItem ${r.dismissed ? 'dim' : ''}`} key={r.id}>
                <StatusPill status={r.status} />
                <div className="rmain">
                  <strong>{MODES.find((m) => m.v === r.mode)?.t || r.mode} · {r.envId}</strong>
                  <small className="auto">
                    <span className="mono">{r.id.slice(0, 8)}</span>
                    {r.retryOf ? ` · إعادة محاولة لـ ${r.retryOf.slice(0, 8)}` : ''}
                    {r.status === 'failed' && r.failure ? ` · ${r.failure.message}` : r.stageDetail ? ` · ${r.stageDetail}` : ''}
                  </small>
                  <div className="actionRow" style={{ marginTop: 6 }}>
                    <a className="ghostButton btn-sm" href={`/projects/${id}/runs/${r.id}`}>عرض</a>
                    {(r.status === 'running' || r.status === 'queued') &&
                      <button className="danger btn-sm" onClick={() => cancel(r.id)} disabled={busy}>إلغاء</button>}
                    {(r.status === 'failed' || r.status === 'cancelled') &&
                      <button className="secondary btn-sm" onClick={() => retry(r.id)} disabled={busy}>إعادة المحاولة</button>}
                    {r.status === 'completed' &&
                      <button className="secondary btn-sm" onClick={() => retry(r.id)} disabled={busy}>تشغيل بنفس الإعدادات</button>}
                    {r.reportExists && <a className="ghostButton btn-sm" href={`/api/runs/${r.id}/report`}>التقرير</a>}
                    {r.status !== 'running' && r.status !== 'queued' && (
                      r.dismissed
                        ? <button className="secondary btn-sm" onClick={() => dismiss(r.id, false)} disabled={busy}>إرجاع للقائمة</button>
                        : <button className="secondary btn-sm" onClick={() => dismiss(r.id, true)} disabled={busy}>إزالة من القائمة</button>
                    )}
                    {r.status !== 'running' && r.status !== 'queued' &&
                      <button className="danger btn-sm" onClick={() => setDeleteRunTarget(r)}>حذف السجل والأدلة</button>}
                  </div>
                </div>
                <div className="rwhen">
                  {fmtDate(r.createdAt)}<br />
                  <Elapsed startedAt={r.startedAt} finishedAt={r.finishedAt} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Confirm
        open={Boolean(deleteRunTarget)}
        title="حذف سجل هذا التشغيل نهائيًا؟"
        body={
          <>
            <p>سيُحذف التقرير والسجلات وحالات الاختبار وكل صور الأدلة لهذا التشغيل.</p>
            <p className="muted">
              إن كان قصدك فقط إخفاؤه من القائمة النشطة، استخدم «إزالة من القائمة» — تلك لا تحذف أي ملف.
            </p>
          </>
        }
        warn="هذا إجراء نهائي لا يمكن التراجع عنه."
        confirmLabel="حذف نهائيًا"
        danger busy={busy}
        onConfirm={confirmDeleteRun}
        onCancel={() => setDeleteRunTarget(null)}
      />
    </main>
  );
}
