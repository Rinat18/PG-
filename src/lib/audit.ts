import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";

/** Журнал действий. Все действия админов пишутся сюда (ТЗ, раздел 7). */
export async function writeAudit(
  actor: string,
  action: string,
  entity: string,
  entityId: string | null,
  data: unknown = {},
  tx: Tx | typeof db = db,
) {
  await tx.insert(auditLog).values({ actor, action, entity, entityId, data });
}
