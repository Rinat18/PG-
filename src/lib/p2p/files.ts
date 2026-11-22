import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { decryptBuffer, encryptBuffer, randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Приватное хранилище документов продавцов (фото паспорта, селфи).
 * Файл шифруется AES-256-GCM до записи: даже с доступом к бакету без DATA_ENCRYPTION_KEY его не прочитать.
 * Публичных ссылок нет — файл отдает только админка роли COMPLIANCE.
 */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStore implements FileStore {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("bad key");
    return full;
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data, { mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
}

class S3Store implements FileStore {
  private client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: Boolean(env.S3_ENDPOINT),
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });
  async put(key: string, data: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: data, ContentType: "application/octet-stream" }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
}

let override: FileStore | null = null;
export function setFileStoreForTests(s: FileStore | null) {
  override = s;
}
function store(): FileStore {
  if (override) return override;
  return env.FILE_STORAGE === "s3" ? new S3Store() : new LocalStore(env.FILE_STORAGE_DIR);
}

export const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAGIC: [string, string, number[]][] = [
  ["jpg", "image/jpeg", [0xff, 0xd8, 0xff]],
  ["png", "image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
];

/** Тип изображения по содержимому (не по имени файла). */
export function detectImage(data: Buffer): { ext: string; mime: string } | null {
  for (const [ext, mime, sig] of MAGIC) {
    if (sig.every((b, i) => data[i] === b)) {
      if (ext === "webp" && data.subarray(8, 12).toString("ascii") !== "WEBP") continue;
      return { ext, mime };
    }
  }
  return null;
}

export const mimeByKey = (key: string) => MAGIC.find(([ext]) => key.endsWith(`.${ext}`))?.[1] ?? "application/octet-stream";

export async function saveDocument(userId: string, kind: "passport" | "selfie", data: Buffer): Promise<string> {
  const img = detectImage(data);
  if (!img) throw new Error("Нужна фотография в формате JPG, PNG или WEBP");
  if (data.length > MAX_DOC_BYTES) throw new Error("Файл больше 8 МБ");
  const key = `verification/${userId}/${kind}-${randomToken(9)}.${img.ext}`;
  await store().put(key, encryptBuffer(data));
  return key;
}

export async function readDocument(key: string): Promise<{ data: Buffer; mime: string }> {
  return { data: decryptBuffer(await store().get(key)), mime: mimeByKey(key) };
}
