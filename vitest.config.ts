import { defineConfig } from 'vitest/config';

// Tests run inside `firebase emulators:exec` (see `pnpm test`), which sets the emulator hosts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: {
      FIREBASE_PROJECT_ID: 'demo-chat',
      FIREBASE_DATABASE_URL: 'https://demo-chat-default-rtdb.firebaseio.com',
      OWNER_EMAILS: 'owner@example.com, someone-else@example.com',
      MOCK_DELAY_MS: '0',
    },
  },
});
