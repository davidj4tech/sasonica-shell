# One umbrella: app, tunnel, shell, installer (draft, 21 Sep 2026)

David asked two things: should the Cloudflare Tunnel live in Runlet (as the
shell was then called), and should the phone app and the shell share one
name. This is how the pieces sit.

**Decided: the umbrella is Sasonica, and the shell is Sasonica Shell.** The
first version of this page kept Runlet as the shell's own name ("Sasonica
Shell, built on Runlet"); that was reversed the same day in favour of a full
rename, recorded in [Renaming the shell](#renaming-the-shell-21-sep-2026).
The name search that led back to Sasonica is kept at the end, as history.

## The pieces

| Piece | What it is | Runs where | Credential | Exists today as |
| --- | --- | --- | --- | --- |
| **Sasonica app** | Chat-first phone client (Capacitor 7 + assistant-ui + our Java audio) | phone | per-device app token | Sasonica (ABS fork) |
| **Sasonica server** | agent-media's HTTP API: sessions, `/ask`, `/conversation`, `/targets`, speech, canvas | your machine | app token, checked server-side | agent-media (`MEDIA_SHARE_TOKEN`) |
| **Sasonica link** | Cloudflare Tunnel publishing the server's HTTP port, so the app works off the tailnet | your machine (`cloudflared`) | tunnel token, scoped to one hostname | nothing (tailnet only) |
| **Sasonica Shell** | The signed command queue for MCP assistants | Worker + D1 + `sasonica.mjs` | runner token + secret connector URL | Sasonica Shell (was Runlet) |
| **installer** | One login to Cloudflare, then provision whichever pieces you ask for | your machine, once | OAuth (`wrangler login`), thrown away after | `install.mjs` in the shell's repo, reached as `sasonica install` |

## Rules that keep it safe

1. **The link never carries the shell, and the shell never carries the app.**
   Two transports, two credentials, two off switches. Enabling the app must not
   enable remote shell access. That is the whole reason not to fold the tunnel
   into the command queue.
2. **The app gets an API, not a command line.** `/ask` already refuses any
   directory `/targets` did not publish; every endpoint the app reaches keeps
   that shape: named actions, validated arguments.
3. **Put Access in front of the link.** Cloudflare Access (service token or
   OTP) on the tunnel hostname, *plus* the app token. Two locks, because this
   hostname is public, unlike the tailnet.
4. **Shell stays opt-in and last.** The installer offers it; it is not a
   prerequisite for the app.

## Why Tunnel and not the queue for the app

- assistant-ui wants streamed responses; the queue polls.
- Audio is bytes in real time; D1 rows are not a media transport (and D1's
  read quota already clipped the relay once).
- The shell is "any command as your user" — the worst possible app contract.

Tunnel keeps agent-media's HTTP/SSE as it is and only changes how it is reached.

## Installer shape

```
sasonica install            # asks which pieces
sasonica install link       # cloudflared + tunnel + DNS + Access policy
sasonica install shell      # the shell: Worker, D1, runner service
sasonica pair               # shows a QR: hostname + app token, scanned by the app
```

`sasonica install` and `sasonica install shell` exist today and are the same
thing, since the shell is the only piece there is; `link` is not built, and
`sasonica install link` says so rather than installing the shell.
`sasonica pair` exists and hands over to agent-media's `media-visual-canvas
pair`: a one-time link and QR for a browser, or for the app with `--device`;
`sasonica devices [--revoke <id>]` lists or forgets the paired apps.

What the rest will share with today's shell installer: account discovery, the OAuth login instead
of a hand-built token, service install per platform (systemd / launchd / Task
Scheduler), the restart-not-enable lesson.

Tunnel provisioning needs different API permissions than today's two
(Workers Scripts, D1): roughly Cloudflare Tunnel: Edit, DNS: Edit on the zone,
Access: Apps and Policies: Edit. Verify with a scoped token the way the
two-permission floor was verified (`795a406`).

Open question: a user with no Cloudflare account and no domain (proposed answer: a hosted relay, a Durable Object per user — `hosted-relay.md`, 27 Sep 2026). Tunnel needs a
zone; quick tunnels (`trycloudflare.com`) are unauthenticated and ephemeral, so
not suitable. Tailscale-only stays a supported mode for that user. David's own
link lives under sasonica.com, already an active zone in his account.

## Repos

Keep the code where it is; share a name, not a monorepo:

- `runlet` — installer + shell + link provisioning. The repo keeps its
  GitHub name for now; everything in it answers to `sasonica`.
- `agent-media` — server
- `Sasonica` — app repo; the ABS fork history gives way to the new app

## The app keeps its name

Sasonica stays; only what is behind it changes. `applicationId` stays
`com.sasonica.app`, so the app updates in place with no reinstall. The GPL
leaves with the ABS-derived code at the ABS exit, so the name carries on under
a liberal licence. Tagline to carry the meaning a coined name can't:
"Talk to your agents".

## Renaming the shell (21 Sep 2026)

**Reversed the same day: the shell is renamed outright, not "built on
Runlet".** The earlier call (above, and in the name check below) was to keep
Runlet as the shell's name, which would have meant carrying two names, or a
compatibility layer that read both. David's reason for reversing it: there are
only one or two installs, both his, so there is nobody to stay compatible for.
Do it right once, while it is cheap.

What changed: the command (`sasonica`), the runner (`sasonica.mjs`), every
`RUNLET_*` setting and Worker secret (now `SASONICA_*`), the config and state
directories (`~/.config/sasonica`, `%APPDATA%\sasonica`), the service
(`sasonica-shell.service`, launchd `com.sasonica.shell`, Scheduled Task
`sasonica-shell`), the Worker and D1 names (`sasonica-shell-<site>`) and the
MCP `serverInfo` (`sasonica-shell`, "Sasonica Shell").

What did not: the HMAC signing scheme and its test vectors (tmux-relay's
d1-runner scheme, byte for byte; a scheme is not a name), `relay.key`, the four
tool names, the D1 table, the LICENSE, and for now the GitHub repo name. An
existing install moves across with `MIGRATING.md`: a new Worker and database
under the new name, then the old ones deleted.

## Name check: "Runlet" (21 Sep 2026)

History. Its verdict, keeping "Runlet" as the shell's name, was superseded by
the rename above; the collisions it lists are part of why that was easy.

Crowded, and one collision is close to exactly what we would be.

- **runletapp / Runlet** — "a cloud-based job manager that integrates your
  devices": the same concept. Proprietary, ToS asserts "Runlet trademarks",
  shipped on winget, Chocolatey and Faronics. Dormant: last release 1.0.8 on
  2022-10-01, and runlet.app now serves a GitHub Pages 404, but the claim and
  the listings remain.
- **runlet.ai** — active "AI-powered n8n workflow builder", with docs at
  runlet.mintlify.app. Same AI-automation space as us, live, and holding the
  `.ai` domain. This is the one most likely to object to a consumer AI app of
  the same name.
- **Package registries all taken:** npm `runlet` (an empty 0.0.0 squat), PyPI
  `runlet` ("tiny observable runtime for Python agents"), crates.io `runlet`
  (an orchestration language for agents, updated this month).
- **Domains:** runlet.com, .dev, .app, .io and .ai are all registered. runlet.sh
  returned no nameservers, so it may be free; that needs a whois check.
- **GitHub:** ~15 repos, mostly tiny; several are agent or sandboxed-execution
  runtimes.
- **Not checked:** USPTO / IP Australia / EUIPO registers (their search is
  interactive). Check class 9 and 42 before committing.

Verdict: fine as the name of a small open-source tool, which is what Runlet is
today. Weak as a consumer app and umbrella brand: two products in the same space
already use it, no domain or package name is free, and store search would
surface the others. Better to pick a fresh umbrella name, keep "Runlet" as the
shell's name, and make the check above (domain, npm, PyPI, Play Store, TM
classes 9/42) the gate for any candidate.

## Candidate names (21 Sep 2026)

Checked: npm, PyPI, GitHub repo-name count, and whether .com/.dev/.app/.ai/.io
have nameservers ("free?" = no NS, which usually but not always means
unregistered; confirm with a registrar). Web search for live products on the
shortlist. Trademark registers still unchecked for all of them.

**Every .com checked is registered.** Plan on a .dev or .app.

Out, because a live product in our space holds it:

| Name | Why out |
| --- | --- |
| Bellwire | wegoft/bellwire: iPhone notifications for AI agent events, on Workers + D1. Nearly our architecture. |
| Aloudly | aloudly.ai: text-to-speech listening app. Same space. |
| Harkly | "Hark" is a $700M-funded personal-AI-interface lab (2026); also Hark Audio podcast app. |
| Sidelong | sidelong.app: AI writing platform. |
| Natterly | live-chat support software of that name. |
| Earshot, Parley, Beckon, Hearken, Lanyard, Holler, Sayso, Chinwag, Colloquy, Outloud, Hollo, Parlo, Speakeasy | packages taken and hundreds of repos, or every domain gone. |

Still standing (packages free, some domains free, no software product found):

| Name | npm | PyPI | GH repos | Free-looking domains | Note |
| --- | --- | --- | --- | --- | --- |
| **Earwell** | free | free | 2 | .dev .app .ai .io | only clash is an infant ear-correction medical device, a different class; "ear" + "well" reads as listening |
| **Yarnbox** | free | free | 3 | .dev .app .ai | a defunct yarn-subscription box; "have a yarn" = have a chat (AU) |
| **Voxtend** | free | free | 2 | .dev .app .io | coined, unsearched on the web |
| Murmurly | free | free | 3 | .dev | unsearched on the web |
| Yarnly, Tellwell | free | free | 6 | .dev | unsearched on the web |

Next gate for any finalist: registrar confirmation, Play Store and App Store
search, IP Australia + USPTO classes 9 and 42.

### Round 2

Leaned Australian and "calling across distance". Mostly out:

| Name | Result |
| --- | --- |
| Offsider | offsider.ai: AI assistant for Australian small businesses. Out, and painfully close. |
| Earful | half a dozen audio apps (AI podcast player, Play Store short podcasts). Out. |
| Currawong | an iOS/macOS amateur-radio voice client; a crate. Weak. |
| Cooee, Bowerbird, Kooka, Porchlight, Tincan, Yonder, Murmuration, Farcall, Hailer | registries taken or 100+ repos, domains gone. |
| **Rouseabout** | survives: npm/PyPI free, 9 repos, .dev/.app/.ai/.io look free; only a local-services booking app and a GitHub user of that name. Long and obscure outside AU. |
| Earpiece | npm/PyPI free, .dev/.io look free; unsearched. |

### Round 3: listening to and controlling your agents

Blends of a listening word and a steering word came back clean where real words
never did.

| Name | Result |
| --- | --- |
| **Earhelm** | npm/PyPI free, 0 GitHub repos, **.com/.dev/.app/.ai/.io all have no nameservers**. Only use found: a World of Warcraft item, a helmet that lets the wearer "hear a whisper at incredible distances". |
| **Earhand** | same: everything free, 0 repos; only a generic earbud listing on made-in-china.com. |
| Harkhelm, Earrein | everything free, 0 repos; unsearched. Harkhelm leans on "Hark" (see round 1). |
| Voxhelm | PyPI taken, .com gone. |
| Comeby (sheepdog command) | ComeBy retail-AI platform + a social app. Out. |
| Kelpie, Callsign, Downbeat, Tiller, Wilco, Heedful | taken everywhere. |

Earhelm is the pick: ear = listen, helm = steer, one word, every domain looking
open including .com. No nameservers is not proof of availability — confirm at a
registrar and register the .com/.app first, then Play Store / App Store search
and IP Australia + USPTO classes 9 and 42.

### Round 4: "a user-friendly way of communicating with your agents"

Friendly plain words are the most taken of all: Talkabout, Chatwell, Hullo,
Palaver, Heyagent, Heyloop (all domains gone), Crewtalk (a push-to-talk app
for film crews, crewtalk.app — out). Only the coined Hollabout came back fully
clean, and it is clunky.

Takeaway: the friendliness has to come from the tagline and the product, not a
literal name. Earhelm + "talk to your agents" rather than a name that says it.

### Sasonica, reconsidered

Cleanest of everything checked: npm and PyPI free, no other GitHub repo,
sasonica.com is **already an active zone in David's Cloudflare account**, and
.dev/.app/.ai/.io have no nameservers. Web hits are a Facebook user, a dormant
YouTube handle and an antique silver pot: no software product.

The only thing that tied it to Audiobookshelf was the fork, which is going. If
kept: Sasonica is the umbrella and the app; Runlet stays the shell's name
("Sasonica Shell, built on Runlet" -- later reversed, see Renaming the shell);
the link hostname lives under
sasonica.com; the `applicationId` can stay `com.sasonica.app`, so no reinstall.

## Related

- agent-media side: `agent-media/docs/simplification-plan.md` (rooms as a
  plugin destination, the ABS exit, splitting the CLI, the server contract).
