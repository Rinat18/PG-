# PlayGround — магазин ключей, Prime, Dota Plus и скинов CS2 / Dota 2

Next.js 15 (App Router) + TypeScript + Tailwind 4 + PostgreSQL + Drizzle ORM.
Оплата только ELQR в сомах, товар выдается только по webhook провайдера с проверенной подписью.

## Запуск локально

```bash
cp .env.example .env              # заполнить DATA_ENCRYPTION_KEY, MOCK_ELQR_WEBHOOK_SECRET, CRON_SECRET, SESSION_SECRET (+ STEAM_API_KEY)
docker compose up -d              # PostgreSQL 16
npm install
npm run db:migrate
npm run db:seed                   # тестовые товары и ключи (только для разработки!)
npm run dev                       # http://localhost:3000
npm run admin:grant -- you@example.com   # после первого входа: сделать себя администратором (/admin)
```

Секреты: `openssl rand -base64 32` для DATA_ENCRYPTION_KEY, `openssl rand -hex 24` для остальных.

Тесты (нужна база `shop_test`, `createdb -O shop shop_test` и `DATABASE_URL=...shop_test npm run db:migrate`):

```bash
npm test
```

## Как проверить покупку

1. Главная → CS2 Prime Status → «Купить» → email + 18+ + оферта.
2. На странице заказа QR и таймер 15 минут. В режиме `PAYMENT_PROVIDER=mock` есть ссылка «страница тестового банка».
3. «Оплатить» в тестовом банке → банк шлет подписанный webhook → страница заказа сама показывает ключ.
4. Письмо с ключом — на `/dev/mail` (без SMTP письма никуда не уходят). Для реальной отправки: `EMAIL_TRANSPORT=smtp` и `SMTP_*` в `.env`.

## Структура

| Путь | Что там |
|---|---|
| `src/db/schema.ts` | Модель данных под все ТЗ, включая P2P (продавцы, лоты, сделки, выплаты) |
| `src/lib/orders/service.ts` | Заказ, резерв, отмена через 15 мин, обработка webhook, выдача, возвраты |
| `src/lib/payments/` | Контракт провайдера ELQR и mock-провайдер |
| `src/lib/crypto.ts` | AES-256-GCM для ключей активации и паспортных данных |
| `src/app/api/payments/webhook/[provider]` | Callback провайдера |
| `src/app/api/cron/expire-orders` | Крон раз в минуту: `GET`/`POST` с `Authorization: Bearer $CRON_SECRET` |
| `src/app/api/cron/send-emails` | Крон раз в минуту: отправка писем из очереди (тот же заголовок) |
| `src/lib/email/` | Шаблоны писем, очередь `email_outbox` с повторами, SMTP (nodemailer) |
| `src/app/dev/mail` | Тестовая почта (только `EMAIL_TRANSPORT=dev` и mock-оплата) |
| `src/app/dev/mock-bank/[id]` | Тестовый банк (только при mock) |
| `src/lib/auth/` | Сессии (подписанная httpOnly-cookie), Steam OpenID 2.0, вход по одноразовой ссылке |
| `src/lib/account.ts` | Кабинет: заказы и ключи только владельца, trade-ссылка только своего Steam |
| `src/lib/steam/buyer-checks.ts` | Проверки покупателя скина через Steam Web API (`STEAM_CHECKS=mock` — только для разработки) |
| `src/lib/admin/` | Админка: права ролей (`rbac.ts`, проверка в каждой функции), заказы и возвраты, товары и ключи CSV, клиенты, балансы продавцов и выплаты, отчеты |
| `src/lib/settings.ts` | Параметры [__] из ТЗ в таблице `settings`, меняются в `/admin/settings` без деплоя |
| `src/lib/payouts/` | Контракт сервиса выплат продавцам и mock |
| `src/lib/security/` | Ограничение частоты по IP (в PostgreSQL) и honeypot |
| `src/middleware.ts` | Редирект `/account/*` на `/login` без cookie сессии |
| `tests/` | Подпись, идемпотентность, просрочка, поддельный webhook, остатки; сессии, OpenID, вход по email, доступ к чужим заказам |

## Правила, которые нельзя ломать

- Нет кейсов, рулеток, случайных выдач, пополняемого баланса покупателя и вывода. Баланс есть только у продавцов P2P: заработок со сделок минус выплаты на их реквизиты; корректировка админом — с причиной и в журнале. Кейсы и капсулы фильтруются при синхронизации инвентаря и выставлении лотов.
- Выдача только в `handlePaymentWebhook` после проверки подписи. Опрос статуса через API провайдера товар не выдает, а только ставит заказ на проверку.
- Один заказ = один платеж; повтор webhook ничего не выдает второй раз.
- Оплата по просроченному заказу уходит на автоматический возврат.
- Деньги в тыйынах (integer), валюта только KGS.

## Подключение реального провайдера

Создать `src/lib/payments/<provider>.ts`, реализующий `PaymentProvider` (createQr, getStatus, verifyWebhook, refund), добавить в `getPaymentProvider` и в enum `PAYMENT_PROVIDER` в `src/lib/env.ts`. Логику заказов менять не нужно.

## Дальше по этапам

- [x] Вход через Steam (OpenID) и по email, личный кабинет, привязка гостевых заказов
- [x] Покупка скинов: вход через Steam, своя trade-ссылка, проверка инвентаря, трейд-бана и trade hold до QR
- [x] Админка: товары, ключи из CSV, заказы, ручная выдача, возвраты, роли, отчеты, настройки, клиенты, балансы продавцов и выплаты (mock)
- [ ] Воркер Steam-ботов: синхронизация инвентаря, очередь `trade_offers`
- [x] Письма: шаблоны, очередь `email_outbox` с повторами, SMTP; тестовая почта `/dev/mail`
- [ ] P2P-маркет: верификация, лоты, сделки, выплаты (после согласования схемы с провайдером)
- [ ] Финальные тексты оферты, правил возврата, политики конфиденциальности; реквизиты вместо [__]
