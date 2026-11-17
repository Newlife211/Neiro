# Запуск боевой версии на VPS

Время: около часа. Нужны банковская карта, домен и доступ к почте.

## 1. Сервер
1. Арендуйте VPS: Hetzner CX22 или DigitalOcean (2 vCPU, 4 ГБ RAM, Ubuntu 24.04). Это около 5–20 € в месяц.
2. Купите домен или используйте поддомен существующего. В DNS добавьте A-запись `office.ваш-домен` → IP сервера.
3. Подключитесь к серверу и установите Docker:
   ```bash
   ssh root@IP_СЕРВЕРА
   curl -fsSL https://get.docker.com | sh
   ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
   ```

## 2. Код
```bash
git clone https://github.com/Newlife211/Neiro.git /opt/neiro
cd /opt/neiro/deploy
cp .env.example .env
nano .env
```

## 3. Ключи (заполняются в `deploy/.env`, в чат и в git их не вставлять)

| Что | Где взять | Переменные |
|---|---|---|
| Токен пульта | `openssl rand -hex 32` | `DIRECTOR_TOKEN` |
| Claude API | console.anthropic.com → API Keys. В разделе Billing поставьте месячный лимит расходов | `ANTHROPIC_API_KEY` |
| Telegram | @BotFather → /newbot. Свой chat id узнайте у @userinfobot. Напишите своему боту /start | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_DIRECTOR_CHAT_ID` |
| Stripe (ЕС) | dashboard.stripe.com → Developers → API keys (сначала тестовый режим `sk_test_…`) | `STRIPE_SECRET_KEY` |
| Вебхук Stripe | Developers → Webhooks → Add endpoint `https://ДОМЕН/webhooks/stripe`, события `checkout.session.completed`, `invoice.paid`, `charge.refunded` → Signing secret | `STRIPE_WEBHOOK_SECRET` |
| ЮKassa (РФ) | yookassa.ru → Интеграция → Ключи API | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` |
| Уведомления ЮKassa | Интеграция → HTTP-уведомления: `https://ДОМЕН/webhooks/yookassa?k=СЕКРЕТ`, события `payment.succeeded`, `refund.succeeded` | `YOOKASSA_WEBHOOK_KEY` |
| AgentMail | console.agentmail.to → API Keys | `AGENTMAIL_API_KEY` |
| Revolut Business | Settings → APIs → Business API (по шагам — `docs/FINANCE.md`) | `REVOLUT_*` |
| Paysera | персональный токен только на чтение | `PAYSERA_TOKEN`, `PAYSERA_ACCOUNT` |

Лимиты трат (`LIMIT_*`) задаются в той же базовой валюте. На старте разумно поставить маленькие:
- 20 € за одну трату;
- 50 € в день;
- 300 € в месяц;
- на Claude API — 10 € в день.

## 4. Запуск
```bash
docker compose up -d --build
docker compose logs -f app
```
Откройте `https://ДОМЕН/` и введите `DIRECTOR_TOKEN`. Если бот настроен, в Telegram придёт «Нейросфера запущена».

## 5. Первая проверка: деньги пока не реальные
1. Stripe держите в тестовом режиме (`sk_test_…`). Поручите в пульте: «Создай тестовую ссылку на оплату 1 € для проекта N». Оплатите её тестовой картой 4242 4242 4242 4242. Оплата должна появиться в разделе «Деньги».
2. Поставьте трату выше лимита и убедитесь, что она пришла в Telegram с кнопками.
3. Нажмите «🛑 СТОП» и убедитесь, что действия встают в ожидание.
4. Только после этого переключите ключи Stripe и ЮKassa на боевые.

## 6. Бэкапы и обновления
```bash
crontab -e   # добавить строку:
15 3 * * * /opt/neiro/deploy/backup.sh >> /var/log/neuro-backup.log 2>&1
```
Обновление кода:
```bash
cd /opt/neiro && git pull && cd deploy && docker compose up -d --build
```
Если что-то пошло не так, нажмите «СТОП» в пульте или отправьте `/stop` боту. Сервер можно остановить целиком командой `docker compose stop app`.
