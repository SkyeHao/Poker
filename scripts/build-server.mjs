import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await rm('dist/server.js', { force: true })

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
})
