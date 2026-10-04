// hosted-join.mjs — the installer's half of joining the hosted relay
// (worker/src/join.ts, docs/hosted-relay.md): start a join, show its link and
// code, wait for the person to sign in and press Join, collect the
// credentials. No Cloudflare account, no token.

import { spawn } from 'node:child_process';

export const DEFAULT_RELAY = 'https://relay.sasonica.com';

/** Best effort: open the link in a browser. The link is printed either way. */
export function openBrowser(url, platform = process.platform) {
  const [exe, argv] = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(exe, argv, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* no browser here: the person opens the printed link */ }
}

/**
 * Join, and resolve with the credentials ({SASONICA_WORKER_URL, …, hmac_key}).
 * `show(url, code)` tells the person what to open and what to match.
 */
export async function joinRelay({ relay = DEFAULT_RELAY, machine, show, fetcher = fetch,
                                  every = 2000, timeoutMs = 15 * 60_000 }) {
  const base = relay.replace(/\/+$/, '');
  const r = await fetcher(`${base}/join/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine }),
  });
  if (!r.ok) throw new Error(`the relay at ${base} did not start a join (HTTP ${r.status})`);
  const { id, code, poll, url } = await r.json();
  show(url, code);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((res) => setTimeout(res, every));
    let p;
    try {
      p = await fetcher(`${base}/join/${id}/poll`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ poll }),
      });
    } catch { continue; }                     // a blip; ask again
    if (p.status === 202) continue;
    if (p.status === 200) return p.json();
    // 404: expired, or the account was refused (the page said which).
    throw new Error('the join ended without this machine (see the page you signed in on); run the installer again');
  }
  throw new Error('no one pressed Join within 15 minutes; run the installer again');
}
