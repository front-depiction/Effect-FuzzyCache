import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [".context/**", "node_modules/**"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        ".context/**",
        "node_modules/**",
        "coverage/**"
      ]
    }
  }
})
