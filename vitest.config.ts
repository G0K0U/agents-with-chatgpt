import { defineConfig } from "vitest/config";

// Synthetic operator environment for hermetic tests. These ids and names are
// fixtures only — real deployments configure their own via the environment.
const TEST_ENV = {
  ZCODE_NATIVE_ALLOWED_WORKSPACES: "1a2b3c4d5e6f,9f8e7d6c5b4a",
  C2C_ENGINEERING_AI_WORKSPACE_ID: "1a2b3c4d5e6f",
  C2C_ONEDRIVE_FOLDER_NAME: "OneDrive - Local Test Account",
};

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    env: TEST_ENV,
  },
});
