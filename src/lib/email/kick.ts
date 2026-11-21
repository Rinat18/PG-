import { after } from "next/server";
import { processOutbox } from "./outbox";

/** Отправить очередь сразу после ответа пользователю, не дожидаясь крона. Только внутри запроса Next. */
export function kickOutbox() {
  after(async () => {
    try {
      await processOutbox({ limit: 10 });
    } catch (e) {
      console.error("[email] фоновая отправка не удалась:", (e as Error).message);
    }
  });
}
