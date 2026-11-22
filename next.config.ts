import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // фото паспорта и селфи продавца приходят через server action (до 8 МБ каждое)
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
};

export default nextConfig;
