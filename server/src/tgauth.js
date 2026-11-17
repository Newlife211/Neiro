// Проверка подписи Telegram Mini App (initData). Без неё мини-приложение не получает доступ к API.
// Алгоритм Telegram: secret = HMAC_SHA256(key="WebAppData", bot_token); hash = HMAC_SHA256(secret, data_check_string).
import crypto from 'node:crypto';

export function verifyInitData(initData, botToken, { maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
  const authDate = Number(p.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;
  try { return { user: JSON.parse(p.get('user') || 'null'), authDate }; } catch { return null; }
}

// Для тестов: собрать подписанный initData так же, как это делает Telegram
export function signInitData(fields, botToken) {
  const p = new URLSearchParams(fields);
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
