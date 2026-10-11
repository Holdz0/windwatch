import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: 'http://localhost:5178',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure'
  },
  webServer: [
    { command: 'node ../backend/src/server.js', url: 'http://localhost:5018/health', env: { PORT: '5018', NODE_ENV: 'development' }, reuseExistingServer: false },
    { command: 'npm run dev -- --port 5178 --strictPort', url: 'http://localhost:5178', env: { VITE_BACKEND_URL: 'http://localhost:5018' }, reuseExistingServer: false }
  ]
});
