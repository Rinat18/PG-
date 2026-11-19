import { defineConfig } from "vitest/config";
import path from "node:path";
import { config } from "dotenv";

const base = config({ path: ".env" }).parsed ?? {};

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    fileParallelism: false,
    env: {
      ...base,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://shop:shop@localhost:5432/shop_test",
      MAX_ORDERS_PER_EMAIL_PER_HOUR: "100",
    },
  },
});
