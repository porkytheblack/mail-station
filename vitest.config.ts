import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@mail-station\/mailbox-station-conformance$/,
        replacement: here("./packages/mailbox-station-conformance/src/index.ts"),
      },
      {
        find: /^@mail-station\/mailbox-station\/effect$/,
        replacement: here("./packages/mailbox-station/src/effect.ts"),
      },
      {
        find: /^@mail-station\/mailbox-station$/,
        replacement: here("./packages/mailbox-station/src/index.ts"),
      },
      {
        find: /^@mail-station\/gmail-station$/,
        replacement: here("./packages/gmail-station/src/index.ts"),
      },
    ],
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "examples/*/src/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
})
