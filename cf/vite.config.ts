import { defineConfig } from "vite";

// Serves the test harness (test/harness.html) for Playwright.
export default defineConfig({
  root: "test",
  // harness.ts imports the shared client from ../src
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
