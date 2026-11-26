import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import { fileURLToPath } from "node:url";

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || "https://privdark-web.ssantyxs.workers.dev",
  base: "/",
  output: "server",
  adapter: cloudflare(),
  integrations: [tailwind({ applyBaseStyles: false })],
  vite: {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
});
