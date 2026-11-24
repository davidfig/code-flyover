// The GitHub pull request each branch belongs to. Git has no pull requests, but GitHub publishes each one's last pushed
// commit as refs/pull/<number>/head, so listing those refs (as a fetch would) and matching commits gives the number.
// It uses whatever sign-in git already has and never asks for one. Only called when the setting is on (web/settings.ts
// showPrs): together with the desktop app's update check it's the only time the app goes to the network.

import { execFile } from 'node:child_process'

const TTL_MS = 5 * 60_000
const TIMEOUT_MS = 20_000

const run = (repo: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repo, ...args],
      { encoding: 'utf8', maxBuffer: 1 << 28, timeout: TIMEOUT_MS, env: { ...process.env, ...env } },
      (e, out) => (e ? reject(e) : resolve(out)),
    )
    child.stdin?.end()
  })

/** Whether a remote's address is on github.com (or a company's own GitHub, with github in its host name). */
export const isGitHub = (url: string) => /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?[^/:]*github[^/:]*[/:]/i.test(url)

/** Commit → the number of the newest pull request it's the head of, from `git ls-remote`'s lines. */
export function parsePulls(out: string): Map<string, number> {
  const pulls = new Map<string, number>()
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/pull\/(\d+)\/head$/.exec(line)
    if (m) pulls.set(m[1], Math.max(Number(m[2]), pulls.get(m[1]) ?? 0))
  }
  return pulls
}

async function fetchPulls(repo: string, remote: string): Promise<Map<string, number>> {
  // Never a prompt or a sign-in window: no credentials to hand means no numbers.
  const ssh = await run(repo, ['config', '--get', 'core.sshCommand']).then((s) => s.trim(), () => '')
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || ssh || 'ssh'} -o BatchMode=yes`,
  }
  return parsePulls(await run(repo, ['-c', 'core.askPass=', 'ls-remote', remote, 'refs/pull/*/head'], env))
}

const lists = new Map<string, { at: number; pulls: Promise<Map<string, number>> }>()
/** The remote's pull requests, asked for at most every few minutes. Failing counts as having none. */
function pullsOf(repo: string, remote: string) {
  const key = `${repo}\n${remote}`
  const hit = lists.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pulls
  const pulls = fetchPulls(repo, remote).catch((e) => {
    console.error(`Couldn't list ${remote}'s pull requests for ${repo}: ${e instanceof Error ? e.message.trim() : e}`)
    return new Map<string, number>()
  })
  lists.set(key, { at: Date.now(), pulls })
  return pulls
}

/** Branch name → pull request number. Only branches with commits of their own, whose last pushed commit a pull request ends at. */
export async function pullNumbers(repo: string, branches: { name: string; sha: string; ahead: number }[]): Promise<Record<string, number>> {
  const remotes: string[] = []
  // A fork's pull requests live on the repo it was forked from, by custom the remote called upstream.
  for (const name of ['upstream', 'origin']) {
    const url = await run(repo, ['remote', 'get-url', name]).then((s) => s.trim(), () => '')
    if (url && isGitHub(url)) remotes.push(name)
  }
  const out: Record<string, number> = {}
  if (!remotes.length) return out
  const pulls = await pullsOf(repo, remotes[0])
  if (!pulls.size) return out
  // Where each branch was last pushed: its local tip may be ahead of that.
  const pushed = new Map<string, string>()
  for (const line of (await run(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes'])).split('\n')) {
    const m = /^refs\/remotes\/([^/]+)\/(.+)\t(\w+)$/.exec(line)
    if (m && m[1] === 'origin') pushed.set(m[2], m[3])
  }
  for (const b of branches) {
    if (!b.ahead) continue
    const n = pulls.get(b.sha) ?? pulls.get(pushed.get(b.name) ?? '')
    if (n) out[b.name] = n
  }
  return out
}
