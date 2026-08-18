import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/data/workspaces/**',
      // Self-mod worktrees are full repo checkouts — without this, a gate run in the
      // main tree would discover and re-run every worktree's test files.
      '**/data/self-mod/**',
    ],
  },
});
