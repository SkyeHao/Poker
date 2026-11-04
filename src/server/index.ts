import { loadConfig, type ServerConfig } from './config.ts'
import { createServer } from './app.ts'

let config: ServerConfig
try {
  config = loadConfig()
} catch (error) {
  console.error(`[config] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const server = await createServer(config)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  server.app.log.info(`shutting down (${signal})`)
  await server.close()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })

try {
  await server.app.listen({ port: config.port, host: config.host })
  if (config.publicUrl === '') {
    server.app.log.warn('[config] PUBLIC_URL is unset; invite links will be derived from request headers')
  }
} catch (error) {
  server.app.log.error(error)
  process.exit(1)
}
