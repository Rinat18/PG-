# PlayGround — магазин ключей, Prime, Dota Plus и скинов CS2 / Dota 2

Next.js 15 (App Router) + TypeScript + Tailwind 4 + PostgreSQL + Drizzle ORM.
Оплата только ELQR в сомах, товар выдается только по webhook провайдера с проверенной подписью.

## Запуск локально

```bash
cp .env.example .env              # заполнить DATA_ENCRYPTION_KEY, MOCK_ELQR_WEBHOOK_SECRET, CRON_SECRET
docker compose up -d              # PostgreSQL 16
npm install
npm run db:migrate
npm run db:seed                   # тестовые товары и ключи (только для разработки!)
npm run dev                       # http://localhost:3000
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

## Структура

| Путь | Что там |
|---|---|
| `src/db/schema.ts` | Модель данных под все ТЗ, включая P2P (продавцы, лоты, сделки, выплаты) |
| `src/lib/orders/service.ts` | Заказ, резерв, отмена через 15 мин, обработка webhook, выдача, возвраты |
| `src/lib/payments/` | Контракт провайдера ELQR и mock-провайдер |
| `src/lib/crypto.ts` | AES-256-GCM для ключей активации и паспортных данных |
| `src/app/api/payments/webhook/[provider]` | Callback провайдера |
| `src/app/api/cron/expire-orders` | Крон раз в минуту: `POST` с `Authorization: Bearer $CRON_SECRET` |
| `src/app/dev/mock-bank/[id]` | Тестовый банк (только при mock) |
| `tests/` | Подпись, идемпотентность, просрочка, поддельный webhook, остатки |

## Правила, которые нельзя ломать

- Нет кейсов, рулеток, случайных выдач, внутреннего баланса, пополнения и вывода. Кейсы и капсулы фильтруются при синхронизации инвентаря и выставлении лотов.
- Выдача только в `handlePaymentWebhook` после проверки подписи. Опрос статуса через API провайдера товар не выдает, а только ставит заказ на проверку.
- Один заказ = один платеж; повтор webhook ничего не выдает второй раз.
- Оплата по просроченному заказу уходит на автоматический возврат.
- Деньги в тыйынах (integer), валюта только KGS.

## Подключение реального провайдера

Создать `src/lib/payments/<provider>.ts`, реализующий `PaymentProvider` (createQr, getStatus, verifyWebhook, refund), добавить в `getPaymentProvider` и в enum `PAYMENT_PROVIDER` в `src/lib/env.ts`. Логику заказов менять не нужно.

## Дальше по этапам

- [ ] Вход через Steam (OpenID) и по email, покупка скинов с trade-ссылкой
- [ ] Админка: товары, загрузка ключей из CSV, заказы, ручная выдача Dota Plus, возвраты, роли
- [ ] Воркер Steam-ботов: синхронизация инвентаря, очередь `trade_offers`
- [ ] Отправка писем из `email_outbox` (SMTP)
- [ ] P2P-маркет: верификация, лоты, сделки, выплаты (после согласования схемы с провайдером)
- [ ] Финальные тексты оферты, правил возврата, политики конфиденциальности; реквизиты вместо [__]
