import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Rust build output, local evidence and worktrees hold many thousands of files the UI never imports;
    // watching them delays the dev server's first response (it made the first visual test of a run time out).
    watch: { ignored: ['**/src-tauri/target/**', '**/.local/**', '**/.worktrees/**'] },
  },
});
