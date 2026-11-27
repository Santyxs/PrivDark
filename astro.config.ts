import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || "https://privdark.pages.dev",
  base: "/",
  publicDir: "assets",
});
