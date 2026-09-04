import crypto from 'node:crypto';

function key(): Buffer {
  const raw = process.env.QA_MASTER_KEY || '';
  if (!raw || raw === 'change-me-before-use') throw new Error('QA_MASTER_KEY must be configured.');
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64');
}

export function decryptJson<T>(encoded: string): T {
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const body = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
}
