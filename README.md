# Technova AI — full stack

A complete AI chat application: Node server, accounts, conversations saved to a database,
streaming answers, and a browser UI. No framework, no build step, no dependencies.

```
npm start          # http://localhost:3000
npm test           # 32 end-to-end checks against a real server
```

## What's inside

| Layer | What it does |
| --- | --- |
| `server.js` | HTTP router, static files, session auth, SSE streaming endpoint |
| `lib/store.js` | JSON document store with atomic writes (the file *is* the database) |
| `lib/auth.js` | scrypt password hashing, session cookies, rate limiting |
| `lib/skills.js` | Deterministic answers: arithmetic, units, dates, product knowledge |
| `lib/provider.js` | Live model when a key is set, local skills when it isn't |
| `public/` | The UI — auth screen, sidebar, thread, thinking panel, composer |

## Features

- **Accounts** — email + password, scrypt hashing, HttpOnly session cookies, 30-day sessions
- **Conversations stored server-side** — they follow the account across browsers and devices
- **Streaming answers** over server-sent events: `meta`, `step`, `reason`, `delta`, `done`
- **Thinking panel** showing the pipeline steps and elapsed time; model reasoning tokens stream into it
- **Two models** — Technova 1.0 Flash and Technova 1.5 Pro, mapped to upstream model ids
- **Edit and resend** your last question — the old answer is replaced, not stacked
- **Custom instructions** per chat, sent to the model ahead of every message
- **Attachments** — attach `.txt`/`.md`/`.json`/`.csv` files and they travel with the message
- **Pin chats** to the top of the sidebar
- **Voice input** in the composer, using the browser's speech recognition
- **Share a chat** as a public read-only link, revocable at any time
- **Command palette** (`Ctrl/Cmd+K`) for chats, actions, theme and accents
- **Four accent colours** — teal, cobalt, amber, plum — remembered per browser
- **Follow-up suggestions** under each answer
- **Per-chat model** — each conversation remembers which model answered it
- **Long transcripts paginate** — 200 messages a page with "load earlier"
- **Delete all chats** from the account menu, with a confirmation
- **Keyboard shortcut help** on `?`
- **Web search** — a globe toggle in the composer; results are streamed to a Sources panel under the answer
- **Deep think** — a brain toggle that raises the reasoning budget and asks the model to work step by step
- **Realtime voice mode** — a hands-free loop: listen, answer, speak, listen again
- **Page reader** — `POST /api/tools/page` turns any URL into readable text
- **Regenerate** any answer, **rename** a chat by double-clicking it in the sidebar
- **Usage panel** — conversations, messages, questions and words for your account
- **Export** one chat as Markdown, or every chat as JSON
- **Stop generating**, copy, speak, delete chat, search chats
- **Dynamic model catalogue** — every model your key can see appears in the menu
- **Light/dark theme**, four accents, mobile layout
- **Shortcuts**: `Ctrl/Cmd+K` palette, `Ctrl/Cmd+Shift+O` new chat, `Esc` closes overlays

## Adding your model key

**From the app** (easiest): the `+` menu → *API key & search* → paste the key → Save. It is stored
on the server, never in the browser, and comes back masked. The `+` menu also holds web search,
agent mode, deep think and file attachments.

**From the environment** (recommended on a host): an `NVIDIA_API_KEY` variable always wins over
anything pasted in the UI.

The key stays on the server. Never put it in a file you share or commit.

```bash
node scripts/setup-key.mjs nvapi-your-key     # writes .env, chmod 600, gitignored
npm start
```

Then open the app: the model menu now lists **every model your key can see**, fetched live
from `GET /api/models` (which proxies the upstream `/v1/models` catalogue and caches it for ten
minutes). Without a key, or if the upstream is unreachable, it falls back to the two built-in models.

## Agent mode

With a key set, the model runs as an agent: it decides which tools to call, the server runs them,
feeds the results back, and loops up to four times before answering. Every call shows up in the
thinking panel, so you can watch it work rather than guess.

| Tool | What it does |
| --- | --- |
| `web_search` | searches the web (needs `TAVILY_API_KEY` or `SEARCH_URL`) |
| `open_browser` | opens the URL in a **real headless Chromium**, returns the rendered text, title and links |
| `fetch_page` | raw HTML → readable text, no browser needed |
| `calculate` | exact arithmetic |
| `current_time` | date and time in IST |

The browser tool needs `npm i playwright-core` plus a Chromium binary — set `BROWSER_PATH` if it
isn't at `/usr/local/bin/chromium`. Without it the tool reports that it is unavailable and the
agent carries on with the others. Turn the whole thing off with the robot toggle in the composer.

## Tools

| Tool | Needs | Notes |
| --- | --- | --- |
| Web search | `TAVILY_API_KEY` or `SEARCH_URL` (SearxNG JSON) | Without either, the toggle still works and reports that no provider is configured |
| Page reader | nothing | Refuses loopback and private addresses unless `ALLOW_LOCAL_FETCH=1` |
| Deep think | nothing | Longer budget and a step-by-step instruction; model reasoning streams into the thinking panel |
| Realtime voice | a browser with speech recognition | Chrome and Edge; degrades with a message elsewhere |

## Configuration

Copy `.env.example` to `.env` and set what you need. Everything is optional — with no key the
app answers from its deterministic skills and never calls the network.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/db.json` | Where conversations and users are stored |
| `NVIDIA_API_KEY` | — | Enables live model answers |
| `MODEL_ENDPOINT` | `https://integrate.api.nvidia.com/v1/chat/completions` | Any OpenAI-compatible endpoint |
| `MODEL_FAST` | `meta/llama-3.1-8b-instruct` | Upstream model behind Technova 1.0 Flash |
| `MODEL_PRO` | `meta/llama-3.3-70b-instruct` | Upstream model behind Technova 1.5 Pro |
| `SECURE_COOKIES` | off | Set to `1` when serving over HTTPS |
| `TAVILY_API_KEY` | — | Enables web search |
| `SEARCH_URL` | — | SearxNG JSON endpoint, if you prefer self-hosting search |
| `ALLOW_LOCAL_FETCH` | off | Dev only: let the page reader reach localhost |

`npm start` reads `.env` automatically (see `lib/env.js`); real environment variables always win
over the file, so the same build works on a host that injects its own.

## API

All endpoints are JSON. Everything except `/api/health` and the auth routes needs the session cookie.

```
GET    /api/health                              provider, models, uptime
GET    /api/models                              full upstream catalogue (cached 10 min)
POST   /api/auth/signup   {email,password,name} 201 + Set-Cookie
POST   /api/auth/login    {email,password}      200 + Set-Cookie
POST   /api/auth/logout                         200
GET    /api/auth/me                             current user

GET    /api/conversations                       list with message counts
POST   /api/conversations  {title}              create
GET    /api/conversations/:id/messages?limit=&before=   transcript, paginated
PATCH  /api/conversations/:id {title,pinned,systemPrompt}   rename, pin, instructions
DELETE /api/conversations/:id                   delete one
DELETE /api/conversations                       delete all of yours
POST   /api/conversations/:id/regenerate        re-answer the last question (SSE)
POST   /api/conversations/:id/edit-last {message}  edit the question and re-answer (SSE)
GET    /api/usage                               your counts and mode
GET    /api/export                              every conversation as JSON
POST   /api/conversations/:id/share             create a public link
DELETE /api/conversations/:id/share             revoke it
GET    /api/shared/:token                       read a shared chat (no session)

POST   /api/chat {message, conversationId?, model?, attachments?, search?, deepThink?} → text/event-stream
POST   /api/tools/search {query}                 run a search directly
POST   /api/tools/page {url}                     readable text from a URL
```

A chat response streams frames like:

```
event: meta   data: {"conversationId":"…","title":"…"}
event: step   data: {"text":"Matched the Calculator skill"}
event: delta  data: {"text":"**12.5% of 8400** = **1050**"}
event: done   data: {"conversationId":"…","source":"Calculator"}
```

## Deploying

### Vercel

Included and working: `api/index.js` hands each request to the same router, `vercel.json`
routes everything to it and bundles `public/`, and the store falls back to the only writable
path on a serverless runtime.

```bash
npm i -g vercel
vercel --prod          # or connect the repo in the dashboard
```

Then set `NVIDIA_API_KEY` (and optionally `TAVILY_API_KEY`) under Settings → Environment Variables.

**The catch, stated plainly:** a Vercel function has no persistent disk. The JSON store lands in
the platform's temp directory, which is wiped on every cold start, so accounts and chats vanish
between invocations and users get signed out at random. It works for a demo of the UI; for real
accounts run it on a host with a disk, or swap `lib/store.js` for Postgres. That is why
`render.yaml` is included.

### Anywhere with a disk

This app wants a **writable disk** and a **long-lived process** — Railway, Render, Fly.io, a VPS,
or Docker.

```bash
docker build -t technova-ai .
docker run -p 3000:3000 -v infinity-data:/app/data -e NVIDIA_API_KEY=your-key technova-ai
```

Behind a proxy, set `SECURE_COOKIES=1` and terminate TLS at the proxy.

## Security notes

- Passwords are hashed with scrypt and a per-user salt; the hash never leaves the server.
- Sessions are random 32-byte tokens in an HttpOnly, SameSite=Lax cookie.
- Auth routes are rate limited to 12 attempts a minute per IP; chat is capped at 40 messages a minute per user.
  Rate-limit buckets are swept every minute so the map cannot grow without bound.
- Attachments are plain text, capped at 5 files and 20,000 characters each.
- Request bodies are capped at 1 MB; conversation access is always scoped to the signed-in user.
- The model key lives only in the server environment — it is never sent to the browser.
- For production, put this behind HTTPS and back up `DB_PATH`.

## Known limits

- The JSON store is fine for a single instance and thousands of conversations; use Postgres or
  SQLite once you need more than one process writing at once.
- No email verification, password reset, or OAuth yet.
- No per-user usage quotas.
