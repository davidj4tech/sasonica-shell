#!/usr/bin/env node
// check-install.mjs — the installer's decisions, without installing anything.
//
//     node tests/check-install.mjs
//
// install.mjs provisions Cloudflare and cannot be exercised here, but what it
// DECIDES -- names, secrets, what goes in the env file, what each service
// manager is told -- is pure, and that is where the bugs have been.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteName, urlSecret, readEnvFile, renderEnv, renderShim, OAUTH_KV_MARKER, oauthKvLine, ownerPolicyBody, accessAppBody,
         winShellCommand, needsWindowsShell } from '../lib/install-lib.mjs';
import { plist } from '../lib/service-macos.mjs';
import { taskCommand } from '../lib/service-windows.mjs';
import { UNIT } from '../lib/service-systemd.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORDS = path.join(ROOT, 'words.txt');

const cases = {
  // These are install.sh's own outputs, checked against it when it was bash:
  // one dash per unsafe character, trimmed, capped at 30.
  siteNamesAreSafe() {
    assert.equal(siteName('MY_PC'), 'my-pc');
    assert.equal(siteName('hpo'), 'hpo');
    assert.equal(siteName('--a  b--'), 'a--b');
    assert.equal(siteName(''), 'site');
    assert.equal(siteName('___'), 'site');
    const long = siteName('x'.repeat(60));
    assert.ok(long.length <= 30 && /^[a-z0-9-]+$/.test(long), long);
  },

  urlSecretComesFromTheWordList() {
    const s = urlSecret(5, WORDS);
    const parts = s.split('-');
    assert.equal(parts.length, 5);
    // /\r?\n/, not '\n': a Windows checkout has CRLF line endings, and
    // splitting on \n alone leaves a \r on every word.
    const list = readFileSync(WORDS, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const p of parts) assert.ok(list.includes(p), `'${p}' is not in words.txt`);
  },

  urlSecretRefusesTooFewWords() {
    assert.equal(urlSecret(2, WORDS).split('-').length, 5);
  },

  urlSecretFallsBackToHex() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sasonica-words-'));
    writeFileSync(path.join(tmp, 'short.txt'), 'one\ntwo\n');
    assert.match(urlSecret(5, path.join(tmp, 'short.txt')), /^[0-9a-f]{48}$/);
    assert.match(urlSecret(5, path.join(tmp, 'absent.txt')), /^[0-9a-f]{48}$/);
    rmSync(tmp, { recursive: true, force: true });
  },

  // The machine that runs commands must not hold an account-wide Cloudflare
  // credential. It reaches its queue through its own Worker instead.
  envFileCarriesNoCloudflareToken() {
    const body = renderEnv({
      accountId: 'acc', site: 'hpo', workerName: 'sasonica-shell-hpo', dbName: 'sasonica-shell-hpo',
      dbId: 'id', secret: 'a-b-c-d-e', workerUrl: 'https://w.example',
      runnerToken: 'tok', keyFile: '/c/relay.key',
    }, '2026-01-01');
    assert.ok(!/CLOUDFLARE_API_TOKEN/.test(body), 'the Cloudflare token is being written to the machine');
    assert.match(body, /^SASONICA_RUNNER_TOKEN=tok$/m);
    assert.match(body, /^SASONICA_WORKER_URL=https:\/\/w\.example$/m);
  },

  // The runner parses the file it writes; hold both to the same regex.
  envFileRoundTripsThroughTheRunnerParser() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sasonica-env-'));
    const f = path.join(tmp, 'env');
    writeFileSync(f, renderEnv({
      accountId: 'acc', site: 's', workerName: 'w', dbName: 'd', dbId: 'i',
      secret: 'one-two-three-four-five', workerUrl: 'https://w.example',
      runnerToken: 'tok', keyFile: '/k',
    }));
    const back = readEnvFile(f);
    assert.equal(back.SASONICA_URL_SECRET, 'one-two-three-four-five');
    assert.equal(back.SASONICA_WORKER_URL, 'https://w.example');
    assert.equal(back.CLOUDFLARE_API_TOKEN, undefined);
    rmSync(tmp, { recursive: true, force: true });
  },

  shimRunsTheRunnerAndForwardsArguments() {
    const posix = renderShim({ node: '/n/node', runner: '/r/sasonica.mjs', win: false });
    assert.match(posix, /^#!\/bin\/sh$/m);
    assert.match(posix, /exec "\/n\/node" "\/r\/sasonica\.mjs" "\$@"/);
    const win = renderShim({ node: 'C:\\n\\node.exe', runner: 'C:\\r\\sasonica.mjs', win: true });
    assert.match(win, /"C:\\n\\node\.exe" "C:\\r\\sasonica\.mjs" %\*/);
  },

  // A plist is XML and these paths can hold & and spaces. install.sh used
  // Python's plistlib to escape them; this builds the XML itself.
  plistEscapesPathsAndKeepsTheRunnerFirst() {
    const xml = plist({
      node: '/opt/node & co/bin/node', runner: '/home/a b/sasonica.mjs',
      home: '/home/a b', logs: '/home/a b/logs',
    });
    assert.ok(!/ & /.test(xml), 'a bare ampersand would make the plist invalid XML');
    assert.match(xml, /<string>\/opt\/node &amp; co\/bin\/node<\/string>/);
    assert.match(xml, /<string>\/home\/a b\/sasonica\.mjs<\/string>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  },

  // Two things this got wrong on a real machine: the log filled with
  // ErrorRecord blocks, and a nested quote pair was eaten by Windows argument
  // parsing, silently turning { "$_" } into { $_ }.
  windowsTaskCommandStringifiesAndAvoidsNestedQuotes() {
    const cmd = taskCommand({ node: 'C:\\node.exe', runner: 'C:\\sasonica.mjs', logPath: 'C:\\runner.log' });
    assert.match(cmd, /ToString\(\)/);
    assert.equal((cmd.match(/"/g) ?? []).length, 0, 'a double quote here is eaten by argument parsing');
    assert.match(cmd, /Out-File -FilePath 'C:\\runner\.log' -Append/);
  },

  // The bootstraps must do nothing but find Node and hand over; anything else
  // is logic that would have to exist twice again.
  bootstrapsOnlyBootstrap() {
    const sh = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const ps = readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
    assert.match(sh, /exec node "\$HERE\/install\.mjs" "\$@"/);
    assert.match(ps, /install\.mjs/);
    for (const [name, text] of [['install.sh', sh], ['install.ps1', ps]]) {
      for (const gone of ['d1/database', 'wrangler deploy', 'SASONICA_URL_SECRET', 'tokens/verify']) {
        assert.ok(!text.includes(gone), `${name} still does provisioning: ${gone}`);
      }
    }
  },

  // process.execPath resolves symlinks, so under fnm or nvm it points inside
  // a version-specific directory that the next upgrade removes. The service
  // must be given the `node` on PATH, which is the stable alias.
  serviceUsesThePathNodeNotTheResolvedOne() {
    const src = readFileSync(path.join(ROOT, 'install.mjs'), 'utf8');
    assert.match(src, /function nodeForService/);
    // Only what OUTLIVES this run matters: the three service managers and the
    // shim. The smoke test may use the interpreter it is already running in.
    for (const call of ['registerTask({ node: NODE', 'installAgent({ node: NODE',
                        'installUnit({ node: NODE', 'renderShim({ node: NODE']) {
      assert.ok(src.includes(call), `this is not given the PATH node: ${call}`);
    }
  },

  // Node 20+ refuses to spawn a .cmd without a shell (CVE-2024-27980), and
  // npm and wrangler on Windows are both .cmd -- it fails with EINVAL before
  // anything runs. shell: true does not quote arguments, so the command line
  // has to be built here or a path with a space in it splits.
  windowsCmdFilesGoThroughTheShellQuoted() {
    assert.equal(needsWindowsShell('npm.cmd'), true);
    assert.equal(needsWindowsShell('wrangler.CMD'), true);
    assert.equal(needsWindowsShell('node.exe'), false);
    assert.equal(needsWindowsShell('/usr/bin/npm'), false);
    const line = winShellCommand('C:\\Program Files\\nodejs\\npm.cmd',
      ['d1', 'execute', 'db', '--file', 'C:\\My Repo\\schema.sql']);
    assert.equal(line,
      '"C:\\Program Files\\nodejs\\npm.cmd" "d1" "execute" "db" "--file" "C:\\My Repo\\schema.sql"');
    assert.ok(!/ (?:--file|C:\\My) /.test(line.replace(/"[^"]*"/g, '')),
      'an unquoted argument would split on its spaces');
  },

  // Listing accounts is the only call that needs Account Settings: Read, so
  // with the id supplied the provisioning token can be two permissions
  // rather than three. Whoever installs this creates that token by hand.
  accountListingIsSkippedWhenTheIdIsKnown() {
    const src = readFileSync(path.join(ROOT, 'install.mjs'), 'utf8');
    const call = src.indexOf("cf('/accounts?per_page=50'");
    assert.ok(call > 0, 'the account listing is gone entirely');
    // It must sit inside the branch taken only when the id is unknown.
    const guard = src.lastIndexOf('if (accountId) {', call);
    assert.ok(guard > 0 && guard < call, 'the account listing is not behind a check for a known id');
    assert.match(src, /Workers Scripts: Edit and D1:/);
  },

  // The MCP path carries the connector secret, and invocation logs record
  // every request's URL -- so they stay off in what the installer deploys.
  invocationLogsStayOff() {
    const tpl = readFileSync(path.join(ROOT, 'worker', 'wrangler.jsonc.template'), 'utf8');
    assert.match(tpl, /"invocation_logs":\s*false/, 'invocation logs would record the secret URL');
  },

  // OAuth (docs/tools-and-approvals.md §6): what the installer asks Cloudflare
  // for, and the KV line it puts in place of the template's marker.
  oauthShapes() {
    const tpl = readFileSync(path.join(ROOT, 'worker', 'wrangler.jsonc.template'), 'utf8');
    assert.ok(tpl.includes(OAUTH_KV_MARKER), 'the template has the marker the installer replaces');
    assert.match(tpl, /"global_fetch_strictly_public"/);
    const withKv = tpl.replace(OAUTH_KV_MARKER, oauthKvLine('0123456789abcdef0123456789abcdef'));
    assert.match(withKv, /"kv_namespaces": \[\{ "binding": "OAUTH_KV", "id": "0123456789abcdef0123456789abcdef" \}\],/);
    assert.deepEqual(ownerPolicyBody('p', 'me@x.com'), { name: 'p', decision: 'allow', include: [{ email: { email: 'me@x.com' } }] });
    const app = accessAppBody({ name: 'sasonica-shell-red5', callback: 'https://w.example/callback', policyId: 'pol' });
    assert.equal(app.type, 'saas');
    assert.equal(app.saas_app.auth_type, 'oidc');
    assert.deepEqual(app.saas_app.redirect_uris, ['https://w.example/callback']);
    assert.deepEqual(app.policies, ['pol']);
    assert.ok(renderEnv({ ownerEmail: 'me@x.com' }).includes('SASONICA_OWNER_EMAIL=me@x.com'));
    assert.ok(!renderEnv({}).includes('SASONICA_OWNER_EMAIL'), 'off unless given');
  },

  // Runlet became Sasonica Shell on 21 Sep 2026, and every name a machine
  // ends up holding moved with it. A stray old name here would make a fresh
  // install land beside the old one under the old name -- or, worse, a re-run
  // on a migrated machine find and reuse the Worker it was meant to leave.
  namesAreSasonicaShell() {
    const src = readFileSync(path.join(ROOT, 'install.mjs'), 'utf8');
    assert.match(src, /`sasonica-shell-\$\{site\}`;\nconst dbName/, 'the default Worker name');
    assert.match(src, /SASONICA_DB_NAME \|\| `sasonica-shell-\$\{site\}`/, 'the default database name');
    assert.equal(UNIT, 'sasonica-shell.service');
    assert.ok(existsSync(path.join(ROOT, UNIT)), `the unit template ${UNIT} is not in the repo`);
    const xml = plist({ node: '/n', runner: '/r', home: '/h', logs: '/l' });
    assert.match(xml, /<key>Label<\/key><string>com\.sasonica\.shell<\/string>/);
    assert.match(readFileSync(path.join(ROOT, 'lib', 'service-windows.mjs'), 'utf8'),
      /taskName = 'sasonica-shell'/);
    for (const f of ['install.mjs', 'sasonica.mjs', UNIT, 'lib/install-lib.mjs',
                     'lib/service-macos.mjs', 'lib/service-systemd.mjs', 'lib/service-windows.mjs',
                     'worker/src/index.ts', 'worker/wrangler.jsonc.template']) {
      // Code may mention the old name in a comment that says it is the old
      // name; it may not USE it. Strip the "called Runlet until" notes first.
      const text = readFileSync(path.join(ROOT, f), 'utf8').replace(/called Runlet until/gi, '');
      assert.ok(!/runlet/i.test(text), `${f} still uses the old name`);
    }
  },

  everyServiceManagerIsCovered() {
    for (const f of ['service-systemd.mjs', 'service-macos.mjs', 'service-windows.mjs', 'install-lib.mjs']) {
      assert.ok(existsSync(path.join(ROOT, 'lib', f)), `lib/${f} is missing`);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(failed ? `check-install: ${failed} case(s) failed` : `check-install: ${Object.keys(cases).length} cases, all pass`);
process.exit(failed ? 1 : 0);
