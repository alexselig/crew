import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'cli-module-hashbang',
    enforce: 'pre',
    transform(code, id) {
      // Vite's SSR evaluator cannot execute CLI hashbangs in non-externalized modules.
      if (id.endsWith('.mjs') && code.startsWith('#!')) return code.replace(/^#![^\r\n]*/, '')
    }
  }],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
