// The viewer, plus the app's local API under /api (server/api.ts): repos, branches, analyses and descriptions.
// The same server runs for `npm run dev` and for the `flyover` command (bin/flyover.mjs).
import { defineConfig, type Plugin } from 'vite'

function api(): Plugin {
  return {
    name: 'code-flyover-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        // Loaded through Vite so edits to the analyzer or the API apply without restarting the server. Connect strips
        // the /api prefix from req.url; put it back so the handler sees the full path.
        req.url = '/api' + (req.url ?? '')
        const { handle } = (await server.ssrLoadModule('/server/api.ts')) as typeof import('./server/api.ts')
        await handle(req, res)
      })
    },
  }
}

export default defineConfig({
  plugins: [api()],
  // Served as they are: they're plain modules, and each grammar is fetched only when a file needs it. Prebundling them
  // would reload the page the first time the worker asks, and copy them into a cache inside the installed app.
  optimizeDeps: { exclude: ['@shikijs/primitive', '@shikijs/vscode-textmate', '@shikijs/types', '@shikijs/engine-oniguruma', '@shikijs/langs'] },
  worker: { format: 'es' },
})
