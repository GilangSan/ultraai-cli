# ultraai-cli

Unofficial Node.js client for **Ultra AI Chat** (`com.ultraai.app` / `ultrachatai.com`).

```js
import { UltraAI } from 'ultraai-cli';

const ai = new UltraAI();                                     // registers a free account for you
console.log(await ai.chat('Explain Tailwind in two sentences.'));
await ai.image('a red apple on a rustic wooden table', { save: 'apple.png' });
await ai.video('a paper plane gliding over a lake, cinematic', { save: 'clip.mp4' });
```

No signup form, no API key, no browser. `new UltraAI()` signs a throwaway account up through the app's
Clerk email-code flow (inbox from [temp.tf](https://temp.tf)) and hands you chat, image and video
generation in three calls. Zero dependencies — Node 18+ `fetch` is all it uses.

```bash
npm i ultraai-cli
```

> Unofficial and reverse-engineered against an undocumented private API. See [Caveats](#caveats).

## Contents

- [Quick start](#quick-start)
- [Cookbook](#cookbook)
- [API](#api)
- [Models](#models)
- [Free plan quotas](#free-plan-quotas)
- [Errors](#errors)
- [How it works](#how-it-works)
- [Caveats](#caveats)
- [Development](#development)

## Quick start

```js
import { UltraAI } from 'ultraai-cli';

const ai = new UltraAI();          // registration starts in the constructor, no await needed

await ai.ready();                  // ~10–30 s while the verification mail arrives
console.log(ai.email, ai.userId);  // coasterdellaripa62+1cmb3jv8hg@outlook.com user_3M8…

console.log((await ai.chat('hi')).text);
```

Every method awaits the account itself, so `ready()` is only needed when you want the address up front.
A failed registration is reported both by the thrown error and on `ai.error`.

**Registration options**

| option | default | meaning |
| --- | --- | --- |
| `email` | — | skip registration and log into this account instead |
| `firstName` / `lastName` | `Alex` / `Nolan` | profile name Clerk asks for |
| `provider` | `outlook` | temp.tf pool: `outlook` \| `hotmail` \| `gmail` |
| `aliases` | `8` | how many temp addresses to burn before giving up |

**Reusing an account.** Accounts are identified by their email only — no password is ever set, login is
another email code. Keep the address and you keep the account:

```js
const ai = UltraAI.login('someone+tag@outlook.com');
```

## Cookbook

### Streaming and multi-turn

```js
const a = await ai.chat('Write a haiku about rain.', {
  onChunk: (t) => process.stdout.write(t),          // SSE deltas as they arrive
});
const b = await ai.chat('Now one about snow.', { conversationId: a.conversationId });
```

### Images

The dedicated image endpoint gives the cleanest result and honours the 2/day image quota:

```js
const shot = await ai.image('a red apple on a rustic wooden table', { save: 'apple.png' });
console.log(shot.buffer.length, shot.mime, shot.revisedPrompt);
```

When that quota runs out the call does **not** fail: by default (`viaChat: 'auto'`) the same prompt is
re-run through the chat route with an image model, which spends chat quota instead. Force either path:

```js
await ai.image(prompt, { viaChat: false });   // dedicated endpoint only, 429 if the quota is gone
await ai.image(prompt, { viaChat: true });    // always through chat
```

An image model is required — a text model comes back as the API's `500 Something went wrong`.

### Video

```js
const clip = await ai.video('a paper plane gliding over a lake at sunset, cinematic', {
  resolution: '480p', aspectRatio: '9:16', length: 5,   // all optional, these are the free-tier values
  save: 'clip.mp4',
  onProgress: ({ phase, interval }) => console.log(phase, interval),
});
console.log(clip.buffer.length, clip.url);
// 2507385 https://ultrachatai.com/api/assets/get/<id>_video_<ts>.mp4
```

Video is an asynchronous tool job, not a request/response endpoint: the submit is answered with
`pollConfig.interval`, and the client re-POSTs the same turn on that interval until the stream carries the
asset URL (~70 s for a 5 s 480p clip). `timeout` defaults to 15 min and `attempts` covers the tool route
refusing a valid turn (see [How it works](#how-it-works)).

### Chat with images inside the answer

Image models also run on the chat route, in the same conversation as the text:

```js
import { MODELS } from 'ultraai-cli';

const { text, images } = await ai.chat('draw a red apple', { model: MODELS.image });
console.log(text, images[0].url);
```

### Talking to endpoints this client does not wrap

```js
const jwt = await ai.token();      // raw Clerk session token, ~60 s
await fetch('https://ultrachatai.com/api/user/get', { headers: { authorization: `Bearer ${jwt}` } });
```

## API

### `new UltraAI(opts?)` → `UltraAI`

Registers an account (or logs in when `opts.email` is set). See the options table above.

### `UltraAI.login(email, opts?)` → `UltraAI`

Same as `new UltraAI({ email, ...opts })`.

### `ai.ready()` → `Promise<UltraAI>`

Resolves once the account exists.

### Properties

| member | type | notes |
| --- | --- | --- |
| `ai.email` | `string` | the address that was registered or reused — all you need to come back |
| `ai.userId` | `string` | Clerk user id |
| `ai.error` | `Error?` | set when the background registration failed |

### Methods

| method | returns | notes |
| --- | --- | --- |
| `ai.user()` | `{ planName, rateLimitConfig, ... }` | plan plus the raw daily limits |
| `ai.models()` | `Model[]` | every id the plan can see, with `input_modalities` / `output_modalities` / `access` / `premium` |
| `ai.token()` | `string` | raw Clerk session JWT, expires in ~60 s |
| `ai.chat(prompt, o?)` | `{ text, images, videos, usage, model, conversationId }` | one SSE turn |
| `ai.image(prompt, o?)` | `{ buffer, url, mime, revisedPrompt, model, path? }` | `viaChat` results carry `text` + `viaChat: true` instead of `revisedPrompt` |
| `ai.video(prompt, o?)` | `{ buffer, url, mime, text, model, conversationId, path? }` | resolves when the clip is rendered |

`chat()` options: `model` (default `MODELS.auto`), `conversationId`, `onChunk`, `tool`, `params`.
`tool` runs an app tool instead of a plain chat — a slug string (`'video-generation'`) or
`{ assistant: '<slug>' }` — and `params` is forwarded verbatim, e.g.
`{ toolSettings: { length, resolution, aspectRatio }, settings: { length: 'auto', tone: 'default' } }`.
That is the same turn `video()` builds, so any tool the app grows can be driven without a client update.

`image()` options: `model` (default `MODELS.image`), `save`, `viaChat`.
`video()` options: `model` (default `MODELS.video`), `resolution`, `aspectRatio`, `length`, `save`,
`timeout`, `attempts`, `interval`, `onProgress`. With `save`, the written path comes back as `result.path`.

### `MODELS`

```js
{ auto: 'fastrouter/autoNew', image: 'google/gemini-2.5-flash-image', video: 'wanx/wan-v3-0', videoTool: 'video-generation' }
```

### `tempEmail(opts?)` → `Promise<string>`

The throwaway-inbox helper on its own: `tempEmail({ providers: 'outlook', timeout: 20000 })`.

## Models

Measured against a fresh free-plan account (`ai.models()` is the source of truth — ids come and go).
Anything flagged premium shows up in the list but answers `403`/`404` on the free plan.

**Chat — 30 working**

- fastrouter: `autoNew`
- anthropic: `claude-haiku-4.5`, `claude-haiku-5.5`
- openai: `gpt-4`, `gpt-4o`, `gpt-4o-mini`, `gpt-5.2`, `gpt-5.4-nano`, `gpt-5.6-luna`, `gpt-5.6-terra`,
  `gpt-6-luna`, `gpt-oss-20b`, `o1`, `o3-mini`
- google: `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-argon`,
  `gemma-4-31b-it`, plus the three image models below
- deepseek: `deepseek-v4.1-flash`, `deepseek-v4-pro`
- others: `x-ai/grok-4.7`, `qwen/qwen3.8-max`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`,
  `minimax/minimax-m3`, `meta-llama/llama-4-scout-17b-16e-instruct`

Listed but dead: `openai/gpt-3.5-turbo`, `openai/o3-mini-high`, `openai/whisper-1` → `404`.

**Image — 4 working**

- `google/gemini-2.5-flash-image` (also `MODELS.image`, the app's own default)
- `google/gemini-nano-banana-2.1`
- `google/gemini-3-pro-image-preview`
- `openai/gpt-image-2`

`openai/gpt-image-1` is listed but answers `500`. All of them also work on the chat route, which is what
the `viaChat` fallback uses.

**Video — 5 working** (1 clip/day per account)

- `wanx/wan-v3-0` (what the app's Videos tab picks), `wanx/wan-v2-6`
- `bytedance/seedance-1.5-pro`, `bytedance/seedance-2`
- `x-ai/grok-imagine-video`

Plan-gated: `google/veo3.1-lite` → `403`. Premium: `kling-ai/kling-v3`,
`x-ai/grok-imagine-video-1.5`, `bytedance/dreamina-seedance-2-5`. Premium chat ids:
`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-fable-5.1`, `gpt-6-sol`, `gpt-6-astra`, `kimi-k3`.

## Free plan quotas

Per **account**, not per IP — a freshly registered account starts from zero, which is the whole reason
this client registers its own.

| capability | limit |
| --- | --- |
| chat | 10 / day |
| image generation | 2 / day |
| video generation | 1 / day |
| prompt optimiser | 7 / day |
| voice agent | 120 s / day |

Exceeding a limit answers `429` with `Usage limit exceeded`.

## Errors

Everything throws `UltraAIError`, with `err.code` and `err.status` mirrored from the API when there is one.

| code | thrown when |
| --- | --- |
| `not_allowed_access`, `form_identifier_exists` | Clerk refuses the address (disposable domain, or the alias is taken) |
| `session_exists` | the same client is already signed in — register one account per instance |
| `code_timeout`, `temp_mail_unavailable` | no verification mail in time / temp.tf down |
| `token_failed`, `no_session` | Clerk session token could not be fetched |
| `empty_response`, `bad_response` | the API answered with something unusable |
| `asset_failed` | the signed asset URL could not be downloaded |
| `video_rejected`, `video_timeout` | the tool route would not accept the turn / the clip never landed |
| `http_error` | non-JSON error body; check `err.message` and `err.status` |

Clerk errors also arrive as `err.code` verbatim (`usage_limit_exceeded`, `too_many_requests`, …).

## How it works

- **Auth** is Clerk's Frontend API (`clerk.ultrachatai.com`), driven headless: create sign-up, prepare
  `email_code`, poll temp.tf for the 6-digit code, verify, then swap the session for a JWT
  (`POST /v1/client/sessions/{id}/tokens`) that is cached and refreshed per call. Bodies are form-encoded
  and carry `Origin` / `Referer` / `_clerk_js_version`, without which Clerk answers `"strategy must be included"`.
  One Clerk client holds one session, so every instance registers exactly one account.
- **Disposable mail**: temp.tf pool aliases (`base+tag@outlook.com`). Plain temp-mail domains are refused by
  Clerk as disposable; a `+tag` on a pool mailbox is accepted (outlook/hotmail repeat, gmail dot-aliases
  only once per mailbox).
- **Chat** is `POST /api/chat/v1` with `Accept: text/event-stream`, parsed into `text` / `images` / `videos` /
  `usage`. The older `/api/chat` sits behind a Cloudflare block and is not used.
- **Tool turns** share the same endpoint: `slugType: 'tool'` + `slug: 'video-generation'` +
  `params.toolSettings`, and the answer is a job (`pollConfig.interval`) that the client polls with the same
  turn id until the asset URL appears.
- Two details the app always sends and the tool routes verify: `referer: https://ultrachatai.com/app/` and
  `sendEmail` / `followupQuesGen` in the body. Get either wrong and a valid turn comes back as
  `400 Request body is required` — `attempts` resubmits with a fresh turn id until one gets through.
- **Assets** live behind `/api/assets/get/...` and need the Bearer token, which this client attaches when
  downloading chat images, generated images and clips.

## Caveats

- Undocumented private API that belongs to someone else. It can change, rate-limit or break any day, and
  it is not affiliated with this package. Keep usage polite and mind their Terms of Service.
- New accounts are created through automated signups. If that is not something you are comfortable with,
  use an account you made yourself (`UltraAI.login(email)`).
- The session JWT lasts ~60 s, so long-running scripts simply refresh it — no long-lived secret is stored.
  Nothing is written to disk except media you ask to `save`.
- Quotas are per account and reset daily; sleeping through the reset is cheaper than hammering `429`s.

## Development

```bash
node test.js            # register, chat, follow-up, image, error guard
node test-video.mjs     # submit → poll → download an mp4 (~70 s, spends the 1/day video quota)
node test-fallback.mjs  # image 429 → chat fallback, plus video()
node verify-models.mjs  # re-check which models the plan really serves (spends a few accounts)
```

The package itself is `index.js` + `package.json` + this file; everything else in the repo is a runnable
check. `npm pack` produces that three-file tarball.

MIT.
