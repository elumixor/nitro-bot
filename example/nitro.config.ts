import { nitroBotModule } from "@elumixor/nitro-bot";

export default defineNitroConfig({
  compatibilityDate: "2025-01-01",
  srcDir: "src",
  experimental: { tasks: false },
  modules: [nitroBotModule()],
});
