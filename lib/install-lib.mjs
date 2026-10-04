// The parts of the installer that are pure functions of their input, so they
// can be tested without provisioning anything.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const hex = (bytes) => randomBytes(bytes).toString('hex');

// One account can hold several of these (one per machine). The site names
// this one; it goes into the Worker and database names so they never collide.
// One dash per unsafe character, as install.sh's `tr -c` gave.
export function siteName(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 30).replace(/^-+|-+$/g, '');
  return s || 'site';
}

// Random words from the EFF short list: a URL a person can read back over the
// phone. randomInt is rejection-sampled, so no word is favoured. Hex if the
// list is missing, so a stripped-down copy still installs.
export function urlSecret(words, wordsFile, note = () => {}) {
  if (!(words >= 4)) { note(`SASONICA_SECRET_WORDS=${words} is too few; using 5`); words = 5; }
  if (existsSync(wordsFile)) {
    const list = readFileSync(wordsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    if (list.length > 1000) {
      return Array.from({ length: words }, () => list[randomInt(list.length)]).join('-');
    }
  }
  note('words.txt not found; using hex');
  return hex(24);
}

// A connector URL. The name, when there is one, sits between the secret and
// /mcp: the Worker reads /<secret>/<name>/mcp, and the URL still ends in /mcp
// for the connector UIs that check. The name only labels the rows a URL
// queues; the secret is the whole credential, so every form of the URL is a
// password. Names are the Worker's alphabet, after lowercasing.
export const URL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
export function connectorUrl(workerUrl, secret, name = null) {
  const base = String(workerUrl ?? '').replace(/\/+$/, '');
  return name ? `${base}/${secret}/${name}/mcp` : `${base}/${secret}/mcp`;
}

export function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return out;
}

// CLOUDFLARE_API_TOKEN is deliberately absent. The runner reaches its queue
// through the Worker, and a D1 API token is account-wide: one left on every
// machine would reach every other machine's queue.
export function renderEnv(v, today = new Date().toISOString().slice(0, 10)) {
  return `# Sasonica Shell — written by install.mjs ${today}.
# The runner token here is this machine's credential for its own Worker.
CLOUDFLARE_ACCOUNT_ID=${v.accountId}
SASONICA_SITE=${v.site}
SASONICA_WORKER_NAME=${v.workerName}
SASONICA_DB_NAME=${v.dbName}
SASONICA_DB_ID=${v.dbId}
SASONICA_URL_SECRET=${v.secret}
SASONICA_WORKER_URL=${v.workerUrl}
SASONICA_RUNNER_TOKEN=${v.runnerToken}
SASONICA_POLL=5
SASONICA_CMD_TIMEOUT=600
SASONICA_KEY_FILE=${v.keyFile}
${v.ownerEmail ? `# OAuth on /mcp (docs/tools-and-approvals.md §6): who may sign a connector in.
SASONICA_OWNER_EMAIL=${v.ownerEmail}
` : ''}${v.signin === 'app' ? `# Sign-ins are approved in the Sasonica app (a code on the page).
SASONICA_SIGNIN=app
` : ''}${v.hosted ? `# A tenant on the hosted relay (install --hosted): no Worker of its own.
SASONICA_HOSTED=1
SASONICA_RELAY_URL=${v.hosted}
` : ''}`;
}

// --- OAuth (docs/tools-and-approvals.md §6) ------------------------------------
// What the installer sends Cloudflare when SASONICA_OWNER_EMAIL is set. Pure,
// so check-install can pin the shapes.

/** The wrangler.jsonc line for the provider's KV, in place of the template's marker. */
export const OAUTH_KV_MARKER = '// __OAUTH_KV__';
export const oauthKvLine = (id) => `"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "${id}" }],`;

/** A reusable Access policy that lets exactly one email through. */
export const ownerPolicyBody = (name, email) => ({
  name, decision: 'allow', include: [{ email: { email } }],
});

/** The Access for SaaS (OIDC) app the Worker signs its owner in with. */
export const accessAppBody = ({ name, callback, policyId }) => ({
  name,
  type: 'saas',
  saas_app: {
    auth_type: 'oidc',
    redirect_uris: [callback],
    grant_type: ['authorization_code_with_pkce'],
    scopes: ['openid', 'email'],
  },
  policies: [policyId],
});

export const renderShim = ({ node, runner, win }) => (win
  ? `@echo off\r\n"${node}" "${runner}" %*\r\n`
  : `#!/bin/sh\nexec "${node}" "${runner}" "$@"\n`);

// Node 20+ refuses to spawn a .cmd or .bat without a shell (the fix for
// CVE-2024-27980), and npm and wrangler on Windows are both .cmd. Going
// through the shell means building the command line by hand: with
// shell: true Node does NOT quote the arguments, so a path with a space in
// it -- C:\\Users\\My Name\\... -- would split.
export const winShellCommand = (exe, argv) =>
  [exe, ...argv].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');

export const needsWindowsShell = (exe) => /\.(cmd|bat)$/i.test(exe);
