# chat.flopbut.pl

Instructions for anyone changing this repository, people and coding agents alike, whatever tool
they work in. `CLAUDE.md` and `GEMINI.md` are symlinks to this file, so each tool that looks for
its own file name reads the same rules. Edit `AGENTS.md`, never the links.

What the service is: [README.md](README.md).

## Typography rule: no em dashes

Never use the long dash character anywhere in this repository: user-facing copy, code, comments,
this file, the README, commit messages and pull request descriptions. Use a plain hyphen instead.

- Wrong: `Чат — только по приглашению`
- Right: `Чат - только по приглашению`

Check with `grep -rn "—" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=kb .`
before committing. `kb/` is a local copy of the knowledge base with rules of its own (see
Knowledge base).

## Name

The only name that appears anywhere public is **Flop Butylkin**. Never substitute another.

## Brand

The design follows [flopbut.pl](https://flopbut.pl), whose token block in
`../flopbut.pl/src/styles/global.css` is the source of truth:

- ink `#0b1312` - near-black with a hint of green, the background
- patina `#5fb79b` - oxidised copper, the mark

The light theme darkens patina to `#0e7159` for contrast in text; logos keep `#5fb79b`. Do not
introduce new hex values for brand surfaces.

Fonts are Geologica, Golos Text and IBM Plex Mono, self-hosted. Those three cover latin,
latin-ext and cyrillic at once.

## Stack

| Piece   | Choice                                                          |
| ------- | --------------------------------------------------------------- |
| Hosting | Google Cloud Run, `europe-west1`, project `flopbut`             |
| Auth    | Firebase Authentication, Google provider only                   |
| Data    | Firebase Realtime Database, written only by the server          |
| Files   | Cloud Storage bucket `flopbut-kb`, the knowledge base           |
| Server  | Node, Hono, TypeScript strict, Firebase Admin SDK               |
| Client  | Vite, React, TypeScript, served by the same container           |
| Tooling | pnpm, Biome, GitHub Actions                                     |
| DNS     | Cloudflare, `chat` CNAME to `ghs.googlehosted.com`, not proxied |

The `chat` record must stay DNS-only (grey cloud): with the proxy on, Google cannot issue the
certificate for the Cloud Run domain mapping.

## Commands

```bash
pnpm emulators   # Firebase Auth + RTDB emulators, UI at localhost:4000
pnpm dev:server  # API on localhost:8080, reads .env, restarts on change
pnpm dev:web     # Vite dev server, proxies /api to :8080
pnpm test        # Vitest inside `firebase emulators:exec`, on its own ports
pnpm build       # SPA into dist/web, server into dist/server
pnpm start       # run the built server
pnpm verify      # lint + type check + tests + build, same as CI
```

Local development runs entirely against the emulators under the `demo-chat` project, so nothing
touches production. The bot reads the knowledge base from a local folder, `kb/` (git-ignored; see
Knowledge base). Copy `.env.example` to `.env` and put your own addresses in `OWNER_EMAILS`.
The emulator's Google sign-in is a fake account picker: type any email, and use an owner address
to get admin.

The emulators need Java 21 or newer. `scripts/firebase.sh` finds one (Homebrew `openjdk`, the JDK
bundled with Android Studio, or `JAVA21_HOME`) without touching the global `JAVA_HOME`.

## Access

- Anyone with a Google account can sign in; the server decides who gets in.
- `members/{uid}` is the access list. Only the server writes it, the RTDB rules forbid all client
  writes (`database.rules.json`, covered by `test/rules.test.ts`).
- `OWNER_EMAILS` (env, comma-separated) lists the owners. An owner with a verified address skips
  invites, gets a member record with `invite: "owner"` and the `admin` custom claim. The claim
  mirrors the list both ways: removing an address revokes admin on that account's next visit.
  A list with no addresses in it is treated as a misconfiguration, not as "no owners": claims are
  then left untouched, and CI refuses to deploy without at least one address.
- Owner addresses are personal: they live in `.env` and the `OWNER_EMAILS` repository secret,
  never in the code.

## Sign-in

- Google sign-in runs on our own domain: the client's `authDomain` is `chat.flopbut.pl`, and the
  server passes every request under `/__/` through to `flopbut.firebaseapp.com` unchanged
  (`server/authProxy.ts`, mounted before the SPA). With the handler on firebaseapp.com, Safari
  and the in-app browsers of iOS (Instagram, Telegram) block the third-party storage that hands
  the result back, and the page stays on "Sign in". See Firebase's
  [redirect best practices](https://firebase.google.com/docs/auth/web/redirect-best-practices).
- This needs `https://chat.flopbut.pl/__/auth/handler` among the authorized redirect URIs of the
  project's OAuth client ("Web client (auto created by Google Service)" under APIs & Services,
  Credentials) and `chat.flopbut.pl` among Firebase Auth's authorized domains. Without the first,
  Google refuses every sign-in with `redirect_uri_mismatch`.
- The client signs in with a popup and falls back to a full-page redirect where popups are
  blocked. Locally the Auth emulator handles both, so the proxy is not used.

## Invites and guests

- Everyone signs in first. `GET /api/me` records anyone who is neither an owner nor a member
  under `guests/{uid}` (profile, `firstSeenAt`, `lastSeenAt`), so they can be invited later.
- A code is 7 characters from an alphabet without look-alikes (`0/o`, `1/l/i`), drawn with
  `crypto.randomInt`. The link is `/invite/{code}`.
- `POST /api/redeem` spends a place inside an RTDB transaction on `invites/{code}`, so the last
  place goes to exactly one account however many arrive at once (`test/invites.test.ts` races
  eight). Do not replace it with a read followed by a write. The member record is then created
  by a transaction that writes only where none exists, so one account opening two links at once
  is admitted once and the losing request gives its place back. The guest record is removed
  after the join, and again on every member visit to `GET /api/me`, in case a refused request
  racing the join wrote it back.
- Only an account's first join spends a place. Members, owners and anyone already listed under
  `invites/{code}/users` get through without spending another. A disabled member stays disabled
  whatever link they open.
- The answer is only `{ joined }`. An unknown, full, expired or withdrawn link leaves the account
  a guest (the code it tried is kept in `guests/{uid}/invite`) and shows the same "You're on the
  list" screen as signing in without a link. Do not add per-reason screens.
- Admins: `GET /api/admin/invites` lists active links (places left, not expired, not revoked),
  newest first; `POST /api/admin/invites` takes `limit` (1-100) and `period` (`day`, `week`,
  `month`, `year`), and the link expires one period from now, months by the calendar. The
  `/admin/invites` page shows the list and a "New link" form.

## Chat

- One chat per account, at `chats/{uid}/messages/{pushId}` (`role`, `text`, `ts`, and `status`
  `streaming` / `done` / `error` on answers). The client reads it live from RTDB; only the
  server writes it.
- `POST /api/chat { text }` (members only, 1-4000 characters) saves the question, then streams
  the answer as server-sent events - `start` with the answer's id, `delta` pieces, then `done`
  or `error` - while saving it to RTDB every 250 ms. The answer is finished and saved even if
  the client goes away. The tab that asked shows the SSE text, other tabs and reloads the RTDB
  copy.
- After the invite, before the chat, a member is asked once about themselves
  (`web/src/About.tsx`, `server/about.ts`): who they are (recruiter at an agency or at the
  company, hiring manager, founder, acquaintance, other), the name to use (filled in from
  Google), their company, the roles they have in mind for Flop and the language to talk in.
  Everything is optional and the form can be skipped; `GET /api/me` says `askAbout` until it is
  answered or skipped, owners are never asked. `POST /api/about` stores it at
  `members/{uid}/about` (free text cut down to letters, digits and a few marks), the bot gets it
  in the note that opens each chat, and the admin's users page shows it.
- The bot speaks first. When the chat screen finds the chat empty (a new member, or after a
  reset or a deletion), it calls `POST /api/chat/open { lang }` with the browser's language. The
  server saves a note marked `hidden: true` in the user's place (`openingNote` in
  `server/chat.ts`: the language and the Google account's name, cut down to letters) and
  streams the bot's greeting like any answer. The note is no question: it leaves `questions`
  and `preview` alone, the member and the admin pages never show it, and the bot keeps it in
  the history. A chat with messages answers 409 `not_empty`, so two tabs greet once. What to
  say is in the system prompt.
- The bot's answers render as Markdown (`web/src/Markdown.tsx`: `react-markdown` with
  `remark-gfm`, no raw HTML, links open in a new tab); questions stay plain text. Images are only
  the knowledge base's photos: the bot writes them as `![...](photos/...)`, the chat fetches them
  from `GET /api/kb/{path}` with the member's token (`web/src/kbImages.ts`) and shows them from a
  blob. Public pictures load straight from an allowlist of hosts (`web/src/imageHosts.ts`:
  `raw.githubusercontent.com`, `media.githubusercontent.com` (files kept in Git LFS),
  `github.com/<owner>/<repo>/raw/...`, `flopbut.pl`,
  `stuff.flopbut.pl`, https only, without a referrer), for photos of open projects that the
  notes link by absolute address. Pictures from anywhere else show as their alt text.
- One question at a time per account: a lock at `chats/{uid}/pending` (a timestamp, taken in a
  transaction, ignored after 3 minutes) answers a second request with 409 `busy`. It lives in
  RTDB because Cloud Run may run several instances.
- The bot sits behind `ChatBackend` in `server/bot/` and gets the whole current chat (every
  finished message, nothing cut or summarised) plus the question, and an abort signal that fires
  after 150 seconds, well inside the lock (it leaves room for waiting for Flop, see Asking Flop). It streams `text` pieces and, at the end, the
  answer's `usage` (tokens, the size the chat came to, and the price when the provider reports
  one). `CHAT_BACKEND` picks the backend, and one missing its key or model stops the server at
  start:
  - `mock` (the default): canned replies with `MOCK_DELAY_MS` between words, each pretending to
    cost $0.01; a message containing `#fail` makes it break off halfway.
  - `openrouter`: the Vercel AI SDK (`ai`) with `@openrouter/ai-sdk-provider`, `CHAT_MODEL`
    defaulting to `anthropic/claude-haiku-5.5`, key in `OPENROUTER_API_KEY`. Usage accounting is
    on, so every answer comes with its price; providers that keep data are excluded
    (`data_collection: deny`); the chat's uid goes as `x-session-id`, so OpenRouter keeps a
    conversation on one provider and its cache warm. Anthropic caches only what is marked
    (`ANTHROPIC_CACHE` in `server/bot/index.ts`, up to four marks): the system prompt and a
    checkpoint on every 5th question live an hour (write 2x the input price), the newest message
    five minutes (write 1.25x); a read costs 0.1x. A lively chat reads everything before each
    question from the cache, and after a longer pause only the questions since the last
    checkpoint are written again. Haiku 5.5 caches nothing shorter than 512 tokens.
  - `anthropic`: straight to Anthropic with `@ai-sdk/anthropic`, `CHAT_MODEL` defaulting to
    `claude-sonnet-5-5`, key in `ANTHROPIC_API_KEY` (a key scoped to a
    workspace). The same cache marks as through OpenRouter. Anthropic reports tokens, not
    prices, so each answer is priced from the published list in `server/bot/anthropicPrice.ts`
    (Haiku 5.5's dearer tier for prompts over 100K tokens included); a model missing from it
    stops the server at start. Models other than Haiku ask for Anthropic's server-side fallback
    (`fallbacks: "default"`): where a safety classifier declines, another model finishes the
    answer in the same call, counted at this model's prices.
  - `openai`: `@ai-sdk/openai`, `CHAT_MODEL` required, key in `OPENAI_API_KEY`. OpenAI does not
    report prices, so these answers do not draw on the allowance.
- The model reads the knowledge base with three tools (`server/bot/kb.ts`): `read_file` (one
  note by its path), `grep` (matching lines across notes, case-insensitive, at most 40) and
  `list_files`. The notes are loaded into memory at start, so a tool can reach nothing else. An
  answer takes at most `MAX_STEPS` (6) model calls, the last without tools so it always ends in
  text. Only that text is kept: the tool calls and the notes read are not, so the next question
  starts from the chat alone, and the chat's `context` is the first call's input plus the
  answer, not the sum of the calls.
- The system prompt is `prompts/system.md`, in English with the rule to answer in the language
  of the question: the bot is Flop Butylkin's AI assistant, mostly for recruiters, and the rules
  on facts, confidentiality, work terms and pay come from the agent policy kept with the
  knowledge base. `{{today}}` becomes the date; `{{kb}}` becomes three files from the root of
  the knowledge base (`PRELOADED` in `server/bot/kb.ts`), whichever exist: `CARD.md`, the
  candidate's card with the key facts, written by hand; `INDEX.md`, the map of every note; and
  `SKILLS.md`, every technology with its years and notes. They take about 35K tokens, cached
  with the prompt, so common questions are answered without a tool call and a chat starts at
  about a sixth of its context limit.
- `chatIndex/{uid}` (`lastAt`, `preview` of the last question, `questions` count) is updated in
  the same write as each question, so the admin's list of chats does not load every message.
  It also holds `cost`, what the current chat has spent, and `totalCost`, across every chat the
  account has had, in dollars, `context`, the tokens the chat came to in its last answer, and
  `usedUpAt`, when it ran out of budget or context (absent while it has some left).
- Routes on the client (`web/src/path.ts`, no router library): `/` is the chat for members,
  `/invite/{code}` the join flow, and for admins `/admin/chats` (every chat, current and
  ended, newest first, each marked `active`, `limit reached` or `ended`; a chat the bot has
  greeted counts even before its first question), `/admin/chats/{uid}` (one chat, live, with
  the price of each answer and links to earlier chats at `/admin/chats/{uid}/archive/{id}`),
  `/admin/users` (members: who, the invite they joined through, when they joined and were last
  seen, how far their chat has got and what they have spent; then guests waiting, with the
  link they tried) and `/admin/invites`. The admin pages read RTDB
  directly through the `admin` claim. Their one write, deleting a chat (a button in the list
  and on the chat), goes through the server: `DELETE /api/admin/chats/{uid}` clears the current
  chat as a reset would, without archiving it, and `DELETE /api/admin/chats/{uid}/archive/{id}`
  removes an earlier one; both take the answers' cost records with them, keep `totalCost`, and
  the first answers 409 `busy` while an answer is being written.

## Asking Flop

- The bot has one more tool, `ask_flop` (`server/flop.ts`), which puts a question to Flop in
  Telegram through the bot `@chat_flopbut_bot`. The model decides when: only when the knowledge
  base has no answer and it matters to the person (`prompts/system.md`, Asking Flop). It sends
  the question in Russian, up to four answers to tap, a summary of the conversation and its
  language.
- Flop gets the question with who asks (name, company and role from the form), the summary, the
  buttons and a link to the chat in the admin pages. He answers with a button, with a reply to
  the message, or with plain text when only one question is open.
- The tool waits for him up to 50 seconds inside the answer. If he answers in time, the bot goes
  on with it. Otherwise the bot says his answer will come; when it does, the bot retells it in
  the chat as a new message, after a hidden note like the opening one (`deliver` in
  `server/chat.ts`, which waits for a question in progress first). When the chat is used up or
  the bot fails, his answer is quoted as it is instead (`post`), without the model.
- A chat may ask at most 3 questions a day and have one open at a time; a question expires
  after 24 hours. An answer to an expired question, or to a chat that has since been reset or
  deleted, does not reach the chat, and Telegram says so. Flop sees each question's outcome
  under it.
- `flopQuestions/{id}` (written only by the server) holds each question; its `status` moves in
  transactions (`waiting`, `open`, `answered`, `delivering`, `delivered`, `expired`,
  `undeliverable`), so an answer is delivered exactly once whichever instance receives it.
- Only Flop's own account counts (`TELEGRAM_OWNER_ID`); other people's messages and buttons are
  ignored. Without `TELEGRAM_BOT_TOKEN` or `TELEGRAM_OWNER_ID` the bot is not offered the tool.
- How answers arrive (`server/telegramWebhook.ts`): in production Telegram calls
  `POST /api/telegram`, checked by the secret header set with the webhook, and each update is
  handled once (`telegram/updates/{update_id}`). The server points the bot's webhook at itself
  when it starts. There is one bot for production and local development: a local server
  (`TELEGRAM_MODE=polling`) takes the webhook off while it runs, reads the updates itself by long
  polling, marks its questions `local`, and puts the webhook back when it stops (with the
  production `TELEGRAM_WEBHOOK_SECRET` in `.env`). While it runs, answers to questions asked in
  production reach it instead and are not delivered; a pressed button says so.

## Allowance

- A chat runs until it has spent `CHAT_BUDGET_USD` (default 1) or grown to
  `CHAT_CONTEXT_TOKENS` (default 200000), whichever comes first: the share used is
  `max(cost / budget, (context - gap) / (limit - gap))`. The gap, `chatContextGapTokens` in
  `server/config.ts` (40000), is what every chat starts with (the system prompt with the
  knowledge base, and the greeting), so the bar stays full until a chat grows past it. There is
  no compaction; keep the context limit well inside the model's window. Owners have no budget,
  but the context limit holds for them too.
- Dollar amounts and token counts are admin-only: `costs/{uid}/{answerId}` (`model`, `input`,
  `output`, `cached` read from the cache, `cacheWrite` written to it, `cost`) and the sums in
  `chatIndex`. The member reads only
  `chats/{uid}/allowance`: `left`, the share left rounded up to whole percent, shown as a bar with
  no amounts, and once it reaches 0, `resetAt`.
- A question to a used-up chat gets 402 `limit_reached`. `resetAt` is the next midnight in Warsaw
  after the chat ran out (for owners, the moment it ran out); from then on
  `POST /api/chat/reset` (409 `not_yet` before) moves the chat's messages to
  `archive/{uid}/{pushId}/messages` and its summary to `archiveIndex/{uid}/{pushId}` (`endedAt`,
  `usedUpAt`, `preview`, `questions`, `cost`, `context`) in one write, and the member starts a
  clean one. Admins may reset their own chat at any time, from a "New chat" button over the
  composer (409 `empty` when there is nothing to put away). The summaries are apart so the
  admin's list does not load old messages. Members only ever see their current chat; the admin
  sees every chat in the list.
- The allowance is rewritten before every question, after every answer and on every visit to
  `GET /api/me`, so changed limits show at once. A failed answer still counts what it cost.

## Knowledge base

- The notes about Flop Butylkin that the bot reads, and their photos, live in the private Cloud
  Storage bucket `gs://flopbut-kb` (`europe-west1`, public access prevented), under `base/`. The
  owner fills it from a local folder: `scripts/kb-push.sh [folder]` (default `kb/`) mirrors the
  folder into `base/`, uploading what changed and deleting what is gone, after showing the list
  and asking. It is one way, the folder wins. It never uploads hidden files, `private/`,
  `node_modules/`, `scripts/` or `package.json`, and it refuses to run while the folder's own
  `scripts/build-index.ts --check` fails.
- The folder's layout and the frontmatter every note carries are described in its README. Its
  `INDEX.md` (the map, one line per note) and `SKILLS.md` are built from that frontmatter by its
  own script, `npm run index` in the folder, run by the owner before a push. `CARD.md` is written
  by hand. The folder is the owner's working copy, git-ignored here; whether it is also a git
  repository is up to the owner.
- The bot works with the bucket as with a folder of files (`server/bot/kb.ts`, `KbFolder`): nothing
  is loaded at start and there are no versions. Every answer lists the folder and puts `CARD.md`,
  `INDEX.md` and `SKILLS.md` into the prompt as they are; its tools `read_file`, `list_files` and
  `grep` list and read the folder at the moment they are called. A file pushed to the bucket is
  seen by the next answer, and an answer that runs during a push may see some old files and some
  new. The one shortcut: a file's text is kept in memory with its stamp (the object's
  generation), so a file that has not changed is not downloaded again. `server/kbBucket.ts` maps
  the objects under `base/` to that folder.
- `/admin/kb` shows the folder as it is (`GET /api/admin/kb`): how many files and notes, the last
  change and which file it was, and a map of every file, folder by folder, with its size, when it
  last changed and what it is to the bot (in the prompt, a note, a photo, or not read).
- `GET /api/kb/{path}` (`server/kbFiles.ts`) serves the photos from the same folder, to members and
  admins only, tagged by the file's stamp and sent with `no-cache`, so the browser checks it
  every time (304 while it holds); the server keeps the last 32 MB in memory. The chat keeps each
  photo for the life of the page (`web/src/kbImages.ts`), so a replaced photo shows from the next
  page load.
- `chat-runtime` may only read the bucket (`scripts/gcp-setup.sh`). The server talks to it through
  the Admin SDK's Cloud Storage client (`server/gcs.ts`), behind a small `ObjectStore` interface
  that the tests replace with one in memory.
- `KB_BUCKET` names the bucket (the deploy sets `flopbut-kb`). Without it, as in local
  development and tests, the same code reads the folder at `KB_DIR` (default `kb`) on disk; with
  no folder either, as in CI's `verify`, the bot runs on its prompt alone. The image carries no
  knowledge base, and the deploy fails if it has a `kb` folder.
- From the bucket or a local folder, the bot's tools see every `.md` file except the three that go
  into the prompt, `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and anything in hidden,
  `scripts`, `node_modules` or `private` folders; photos are `jpg`, `png`, `webp` and `gif` up to
  5 MB each. Biome skips `kb/`.

## Deployment

`.github/workflows/ci.yml` runs `pnpm verify` on every pull request and push. A push to `main`
then publishes `database.rules.json` to the production RTDB, builds the image, pushes it to
Artifact Registry (`europe-west1-docker.pkg.dev/flopbut/chat/app`) and deploys the Cloud Run
service `chat`. The rules in the repository are the rules in production: never edit them in the
console. GitHub authenticates as `chat-deployer` through Workload
Identity Federation; the service runs as `chat-runtime`. Repository variables: `GCP_WIF_PROVIDER`
and `GCP_DEPLOY_SA`, plus `CHAT_BACKEND`, `CHAT_MODEL`, `CHAT_BUDGET_USD` and
`CHAT_CONTEXT_TOKENS` for the bot (blank means the defaults, so the mock). Repository secrets,
because the repository and its Actions logs are public and a secret shows there masked:
`OWNER_EMAILS` and `TELEGRAM_OWNER_ID`, Flop's Telegram account. Never put a personal value in a
variable, or inline in a workflow. The service's request timeout is 600 seconds,
so a late answer from Flop can wait for the chat and then be retold within one webhook call.

The bot's API keys live in Secret Manager (region `europe-west1`): `openrouter-api-key` reaches
the service as `OPENROUTER_API_KEY`, `anthropic-api-key` as `ANTHROPIC_API_KEY`, `openai-api-key`
as `OPENAI_API_KEY`. The deploy mounts only
the key of the backend in use and takes the others off the service, so a key never outlives its
backend; `CHAT_BACKEND=anthropic` needs `anthropic-api-key` to exist, `openai` needs
`openai-api-key`. The Telegram bot's `telegram-bot-token` and `telegram-webhook-secret` are
always mounted, as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, so both must exist before
a deploy. The deploy also takes off `GITHUB_KB_TOKEN`, left from when the knowledge base was
read from GitHub. `scripts/gcp-setup.sh` lets `chat-runtime` read whichever of them exist. To
replace a key, add a version: `printf '%s' "$KEY" | gcloud secrets versions add openrouter-api-key --data-file=-`, then
redeploy.

The IAM side of this is set up once by the project owner with `scripts/gcp-setup.sh`.

## Working in git

Commit straight to `main`: no feature branches, no pull requests. Every push to `main` deploys to
production, so run `pnpm verify` before a commit; CI runs it again and does not deploy when it
fails.

Nothing is pushed without explicit approval for that specific push.

Raster images (PNG, JPEG, GIF, WebP, AVIF, ICO and the rest listed in `.gitattributes`) are stored
in Git LFS, so install `git-lfs` before committing one. SVG stays plain text.

## Secrets

No service account JSON keys, anywhere. On Cloud Run the server uses the runtime service
account's default credentials; CI authenticates through Workload Identity Federation. Local
values live in `.env`, which is git-ignored.
