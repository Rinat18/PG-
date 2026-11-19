/** Деньги храним в тыйынах. На витрине показываем целые сомы, если копеек нет. */
export function formatKgs(minor: number): string {
  const som = minor / 100;
  const hasFraction = minor % 100 !== 0;
  return (
    new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(som) + " сом"
  );
}

export const gameLabel: Record<string, string> = { CS2: "CS2", DOTA2: "Dota 2", OTHER: "Другие игры" };

export const productTypeLabel: Record<string, string> = {
  GAME_KEY: "Ключ игры / DLC",
  CS2_PRIME: "CS2 Prime",
  DOTA_PLUS: "Dota Plus",
  SHOP_SKIN: "Скин",
};

export const orderStatusLabel: Record<string, string> = {
  PENDING_PAYMENT: "Ожидает оплаты",
  PAID: "Оплачен",
  TRADE_SENT: "Трейд отправлен",
  DELIVERED: "Выдан",
  PROBLEM: "Проблема",
  REFUNDED: "Возврат",
  CANCELLED: "Отменен",
};
