// Одноразовый обмен кода авторизации Revolut на refresh token.
// Запуск на сервере: docker compose run --rm app node src/tools/revolut-auth.js КОД
import { loadDotEnv } from '../config.js';
import { revolutConfig, clientAssertion } from '../revolut.js';

loadDotEnv(process.env.ENV_FILE || '.env');
const code = process.argv[2];
const rc = revolutConfig({ ...process.env, REVOLUT_REFRESH_TOKEN: 'pending' });
if (!code || !rc.clientId || !rc.privateKeyPem || !rc.iss) {
  console.error('Нужно: REVOLUT_CLIENT_ID, REVOLUT_JWT_ISS, REVOLUT_PRIVATE_KEY_PATH в .env и код из адреса после согласия: node src/tools/revolut-auth.js КОД');
  process.exit(1);
}
const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: rc.clientId,
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: clientAssertion(rc) });
const r = await fetch(rc.base + '/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
const j = await r.json();
if (!r.ok || !j.refresh_token) { console.error('Ошибка Revolut:', j.error_description || j.error || r.status); process.exit(1); }
console.log('\nГотово. Впишите в deploy/.env строку (никому её не показывайте):\n');
console.log('REVOLUT_REFRESH_TOKEN=' + j.refresh_token + '\n');
