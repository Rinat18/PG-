import type { products } from "@/db/schema";
import { saveProductAction } from "../actions";

type P = typeof products.$inferSelect;

const types = [["GAME_KEY", "Ключ игры / DLC"], ["CS2_PRIME", "CS2 Prime"], ["DOTA_PLUS", "Dota Plus"], ["SHOP_SKIN", "Скин (из бота)"]];
const games = [["CS2", "CS2"], ["DOTA2", "Dota 2"], ["OTHER", "Другие игры"]];
const methods = [["KEY", "Ключ (автоматически)"], ["STEAM_GIFT", "Подарок Steam (оператор)"], ["MANUAL", "Вручную оператором"], ["TRADE_OFFER", "Трейд-оффер (скины)"]];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1 text-sm"><span className="text-muted">{label}</span>{children}</label>;
}

export function ProductForm({ p }: { p?: P }) {
  return (
    <form action={saveProductAction} className="card grid gap-4 p-6 md:grid-cols-2">
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Название"><input name="title" required defaultValue={p?.title} className="input" /></Field>
      <Field label="Адрес (slug)"><input name="slug" required defaultValue={p?.slug} className="input" placeholder="cs2-prime-status" /></Field>
      <Field label="Тип">
        <select name="type" defaultValue={p?.type ?? "GAME_KEY"} disabled={Boolean(p)} className="input">
          {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {p && <input type="hidden" name="type" value={p.type} />}
      </Field>
      <Field label="Игра">
        <select name="game" defaultValue={p?.game ?? "OTHER"} className="input">{games.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <Field label="Цена, сом"><input name="priceSom" required inputMode="decimal" defaultValue={p ? (p.priceMinor / 100).toString() : ""} className="input" /></Field>
      <Field label="Способ выдачи">
        <select name="deliveryMethod" defaultValue={p?.deliveryMethod ?? "KEY"} className="input">{methods.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <Field label="Срок выдачи (текст на карточке)"><input name="deliveryEta" required defaultValue={p?.deliveryEta ?? "Сразу после оплаты"} className="input" /></Field>
      <Field label="Регион активации"><input name="region" defaultValue={p?.region ?? ""} className="input" /></Field>
      <Field label="Срок подписки, мес. (Dota Plus)"><input name="durationMonths" type="number" min={0} defaultValue={p?.durationMonths ?? ""} className="input" /></Field>
      <Field label="Фото (https://…)"><input name="imageUrl" defaultValue={p?.imageUrl ?? ""} className="input" /></Field>
      <div className="md:col-span-2"><Field label="Описание"><textarea name="description" rows={3} defaultValue={p?.description} className="input" /></Field></div>
      <div className="md:col-span-2"><Field label="Инструкция по активации"><textarea name="activationInstructions" rows={2} defaultValue={p?.activationInstructions} className="input" /></Field></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={p?.isActive ?? true} /> Показывать в каталоге</label>
      <div className="md:text-right"><button className="btn-primary">Сохранить</button></div>
    </form>
  );
}
