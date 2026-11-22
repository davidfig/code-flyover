import { defineConfig } from "cf/config";

// The landing page at codeflyover.app: the static files in site/, deployed with `npm run deploy:site`.
export default defineConfig({
  worker: {
    name: "codeflyover-site",
    compatibilityDate: "2026-11-22",
    domains: ["codeflyover.app", "www.codeflyover.app"],
  },
});
