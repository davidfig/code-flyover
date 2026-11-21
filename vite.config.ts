// The viewer, plus the app's local API under /api (server/api.ts): repos, branches, analyses and descriptions.
// The same server runs for `npm run dev` and for the `semantic-zoom` command (bin/semantic-zoom.mjs).
import { defineConfig, type Plugin } from 'vite'

function api(): Plugin {
  return {
    name: 'semantic-zoom-api',
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
})
