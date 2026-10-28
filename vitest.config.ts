import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// The client test suite runs under jsdom because the hook and component tests
// added alongside the state refactor rely on real effects, DOM events and
// localStorage — none of which run under react-dom/server.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    // Pinned so the suite does not silently change shape with a developer's
    // local .env — this workspace has VITE_IS_PLATFORM=true, CI has no .env at
    // all, and the flag decides whether the app authenticates with a bearer
    // token. The tests that care stub it per case and assert both modes.
    env: {
      VITE_IS_PLATFORM: 'false',
    },
    // The memory guard loads first so it is armed before any test code runs.
    setupFiles: ['./vitest.memory-guard.ts', './vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    // A test fails after 10 s, raised from vitest's 5 s default. A hook also fails after 10 s,
    // and on shutdown vitest waits at most 10 s for the run to close; those two are vitest's
    // defaults, written out to keep the limits together. None of them ends a test stuck in a
    // synchronous loop, whose timers never get to run: the memory guard kills one that keeps
    // allocating, and the `timeout` the test command runs under one that only burns CPU.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
  },
});
