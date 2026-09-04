'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TopBar, api } from '../ui';

type Acc = { id: string; role: string; label: string; loginType: string; identifier: string; password: string };

/**
 * Generates a QA definition for whatever system the user is testing. Every field
 * starts empty — there is no preloaded project, customer or account anywhere here.
 */
export default function Wizard() {
  const router = useRouter();
  const [form, setForm] = useState({
    projectId: '', name: '', description: '',
    envId: 'qa', envLabel: 'QA', kind: 'qa',
    apiBaseUrl: '', openapiUrl: '', webUrl: '', webAppLabel: '',
    catalogUrl: '', requiredRoles: '',
    preferredLanguage: 'en', destructiveActions: 'allow-build-test-only',
  });
  const [accounts, setAccounts] = useState<Acc[]>([
    { id: 'admin-qa', role: 'admin', label: '', loginType: 'email_password', identifier: '', password: '' },
  ]);
  const [out, setOut] = useState('');
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const setAcc = (i: number, k: keyof Acc, v: string) =>
    setAccounts((x) => x.map((a, n) => (n === i ? { ...a, [k]: v } : a)));

  async function generate() {
    setBusy(true); setError(''); setWarning(''); setOut('');
    try {
      const j = await api<{ raw: string; warning?: string }>('/api/wizard', {
        method: 'POST', body: JSON.stringify({ ...form, accounts }),
      });
      setOut(j.raw);
      if (j.warning) setWarning(j.warning);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function importNow() {
    setBusy(true); setError('');
    try {
      const j = await api<{ project: { id: string } }>('/api/projects/import', {
        method: 'POST',
        body: JSON.stringify({ raw: out, filename: 'wizard-generated.md', onConflict: 'ask' }),
      });
      router.push(`/projects/${j.project.id}`);
    } catch (e: any) {
      setError(e.status === 409
        ? 'يوجد مشروع مطابق مسبقًا. انسخ الملف واستورده من مكتبة المشاريع لتختار التحديث أو نسخة جديدة.'
        : e.message);
    } finally { setBusy(false); }
  }

  const canGenerate = form.name.trim() && (form.webUrl.trim() || form.apiBaseUrl.trim());

  return (
    <main className="shell">
      <TopBar active="wizard" />
      <div className="crumbs">
        <a href="/">مكتبة المشاريع</a><span className="sep">/</span><span>إنشاء تعريف QA</span>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>إنشاء ملف تعريف النظام</h2>
            <p className="muted">لمن ما عنده ملف جاهز: عبّي الأساسيات، أضف حسابات QA أو رابط كتالوج حسابات حيّ، وولّد الملف.</p>
          </div>
        </div>

        <div className="formGrid">
          <label>اسم النظام *<input className="auto" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="مثال: My Platform" /></label>
          <label>وصف مختصر<input className="auto" value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
          <label>projectId ثابت (اختياري، يمنع التكرار عند إعادة الاستيراد)
            <input dir="ltr" value={form.projectId} onChange={(e) => set('projectId', e.target.value)} placeholder="my-platform" /></label>
          <label>نوع البيئة
            <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              {['qa', 'staging', 'production', 'local', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}
            </select></label>
          <label>رابط API<input dir="ltr" value={form.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} placeholder="https://api.example.com" /></label>
          <label>رابط OpenAPI<input dir="ltr" value={form.openapiUrl} onChange={(e) => set('openapiUrl', e.target.value)} placeholder="https://api.example.com/openapi.yaml" /></label>
          <label>رابط تطبيق الويب<input dir="ltr" value={form.webUrl} onChange={(e) => set('webUrl', e.target.value)} placeholder="https://app.example.com" /></label>
          <label>اسم تطبيق الويب<input className="auto" value={form.webAppLabel} onChange={(e) => set('webAppLabel', e.target.value)} placeholder="Dashboard" /></label>
        </div>

        <h2 style={{ marginTop: 22 }}>كتالوج حسابات حيّ (اختياري)</h2>
        <p className="muted">
          إذا كان نظامك ينشر حسابات QA على رابط JSON، ضعه هنا وسيُجلب قبل كل تشغيل بدل تثبيت كلمات مرور داخل الملف.
        </p>
        <div className="formGrid">
          <label>رابط الكتالوج<input dir="ltr" value={form.catalogUrl} onChange={(e) => set('catalogUrl', e.target.value)} placeholder="https://api.example.com/qa/accounts.json" /></label>
          <label>أدوار مطلوبة (مفصولة بفواصل)<input dir="ltr" value={form.requiredRoles} onChange={(e) => set('requiredRoles', e.target.value)} placeholder="admin, member" /></label>
        </div>

        <h2 style={{ marginTop: 22 }}>حسابات QA ثابتة</h2>
        <p className="muted">اتركها فارغة إذا كنت تستخدم الكتالوج الحيّ. القيم تُشفّر عند الاستيراد ولا تُعرض بعدها.</p>
        <div className="stack">
          {accounts.map((a, i) => (
            <div key={i} className="accountEdit">
              <input placeholder="id" dir="ltr" value={a.id} onChange={(e) => setAcc(i, 'id', e.target.value)} />
              <input placeholder="role" dir="ltr" value={a.role} onChange={(e) => setAcc(i, 'role', e.target.value)} />
              <input placeholder="email / phone / username" dir="ltr" value={a.identifier} onChange={(e) => setAcc(i, 'identifier', e.target.value)} />
              <input type="password" placeholder="password" value={a.password} onChange={(e) => setAcc(i, 'password', e.target.value)} />
            </div>
          ))}
        </div>
        <div className="row">
          <button className="secondary" onClick={() => setAccounts((x) => [...x, { id: `account-${x.length + 1}`, role: '', label: '', loginType: 'email_password', identifier: '', password: '' }])}>
            إضافة حساب
          </button>
          {accounts.length > 0 && <button className="secondary" onClick={() => setAccounts((x) => x.slice(0, -1))}>حذف الأخير</button>}
          <button onClick={generate} disabled={busy || !canGenerate}>{busy && <span className="spinner" />}توليد الملف</button>
        </div>
        {!canGenerate && <p className="muted" style={{ marginTop: 8 }}>مطلوب على الأقل: اسم النظام + رابط ويب أو رابط API.</p>}
        {error && <div className="notice" style={{ background: '#fef6f4', color: '#8f342b' }}>{error}</div>}
        {warning && <div className="notice" style={{ background: '#fff3cf', color: '#7e6115' }}>تحذير: {warning}</div>}

        {out && (
          <>
            <h2 style={{ marginTop: 22 }}>الملف الناتج</h2>
            <textarea value={out} onChange={(e) => setOut(e.target.value)} />
            <div className="row">
              <button onClick={importNow} disabled={busy}>{busy && <span className="spinner" />}استيراد الآن كمشروع</button>
              <button className="secondary" onClick={() => navigator.clipboard?.writeText(out)}>نسخ</button>
              <a className="ghostButton" download="qa-system.md"
                href={`data:text/markdown;charset=utf-8,${encodeURIComponent(out)}`}>تنزيل الملف</a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
