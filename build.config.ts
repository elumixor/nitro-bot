import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index", "src/runtime"],
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: false,
    inlineDependencies: false,
    esbuild: {
      jsx: "automatic",
    },
  },
  externals: [
    "h3",
    "zod",
    "ai",
    "react",
    "react/jsx-runtime",
    "nitropack",
    "nitropack/runtime",
    "grammy",
    "@elumixor/react-message-renderer",
    "@elumixor/react-telegram",
    "#nitro-bot",
  ],
  failOnWarn: false,
});
