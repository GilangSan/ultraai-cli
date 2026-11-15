/**
 * Ultra AI Chat (com.ultraai.app) client.
 *
 * `new UltraAI()` registers a free account on the fly (Clerk email-code signup, temp-mail inbox)
 * and every method waits for that to finish, so you can just call ai.chat()/ai.image() right away.
 *
 *   import { UltraAI } from 'ultraai-chat';
 *   const ai = new UltraAI();
 *   console.log(await ai.chat('hello'));
 *   await ai.image('a red apple', { save: 'apple.png' });
 *
 * Zero dependencies — Node 18+ (global fetch, res.headers.getSetCookie).
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const CLERK = 'https://clerk.ultrachatai.com';
const APP = 'https://ultrachatai.com';
const TEMPMAIL = 'https://temp.tf';
const CLERK_JS = '6.43.0';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

/** usable model ids, from ai.models() */
export const MODELS = {
  auto: 'fastrouter/autoNew',                      // picks a text model for you
  image: 'google/gemini-2.5-flash-image',          // image out via chat(); also the default for image()
  video: 'wanx/wan-v3-0',                          // video out via the 'video-generation' tool
  videoTool: 'video-generation',                   // slug of the app's video tool
};

export class UltraAIError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'UltraAIError';
    this.code = code;
    this.status = status;
  }
}

/** temp.tf pool address Clerk accepts: an outlook/hotmail +alias (its own domain is blocklisted). */
export async function tempEmail({ providers = 'outlook', timeout = 20000 } = {}) {
  const res = await fetch(`${TEMPMAIL}/api/account?providers=${providers}&dot=0&plus=1`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new UltraAIError(`temp.tf ${res.status}`, 'temp_mail_unavailable', res.status);
  return (await res.json()).email.toLowerCase();
}

export class UltraAI {
  #cookies = new Map();
  #jwt = null;
  #jwtAt = 0;
  #sessionId = null;
  #email;
  #userId;
  #ready;

  /**
   * @param {object} [opts]
   * @param {string} [opts.email]     reuse an account (email-code login) instead of registering
   * @param {string} [opts.firstName] profile name used when registering
   * @param {string} [opts.lastName]
   * @param {string} [opts.provider]  temp.tf pool: 'outlook' (default) | 'hotmail' | 'gmail'
   * @param {number} [opts.aliases]   how many temp addresses to try before giving up
   */
  constructor(opts = {}) {
    this.opts = { firstName: 'Alex', lastName: 'Nolan', provider: 'outlook', aliases: 8, ...opts };
    this.#ready = (opts.email ? this.#login(opts.email) : this.#register()).catch((err) => {
      this.error = err;
      throw err;
    });
  }

  /** reuse an existing account (email verification code, no password) */
  static login(email, opts = {}) {
    return new UltraAI({ ...opts, email });
  }

  /** resolve once the account is ready (every public method awaits this anyway) */
  ready() {
    return this.#ready;
  }

  get email() {
    return this.#email;
  }

  get userId() {
    return this.#userId;
  }

  /** Free Plan (Ultra AI) + rateLimitConfig: chat 10/day, image_generation 2/day, … */
  async user() {
    await this.#ready;
    const { user } = await this.#app('/api/user/get');
    return user;
  }

  /** every model the app offers, with input/output modalities */
  async models() {
    await this.#ready;
    return (await this.#app('/api/models')).data ?? [];
  }

  /** the raw Clerk session JWT, for endpoints this client does not wrap (expires in ~60 s) */
  async token() {
    await this.#ready;
    return this.#token();
  }

  /**
   * One turn of chat (SSE). Returns the answer plus any images the model produced.
   * @param {string} prompt
   * @param {object} [o]
   * @param {string} [o.model]           MODELS.auto by default
   * @param {string} [o.tool]            run an app tool instead of a plain chat, e.g. 'video-generation';
   *                                     use `tool: { assistant: '<slug>' }` for an assistant
   * @param {object} [o.params]          forwarded as `params` (toolSettings, articleId, …)
   * @param {string} [o.conversationId]  pass the id from a previous call to keep context
   * @param {(chunk: string) => void} [o.onChunk]
   * @returns {Promise<{text: string, images: Array, videos: Array, usage: object|null, model: string, conversationId: string}>}
   */
  async chat(prompt, { model = MODELS.auto, tool, params, conversationId, onChunk } = {}) {
    await this.#ready;
    const conv = conversationId ?? randomUUID();
    const message = {
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      requestStartTime: Date.now(),
    };
    const body = {
      model,
      webSearch: false,
      conversation_id: conv,
      slugType: tool ? 'tool' : 'assistant',
      slug: (tool && typeof tool === 'object' ? tool.assistant : tool) ?? 'omni',
      userPreferences: {},
      streamAudio: false,
      message,
      sub_conversation_id: conv,
      query_id: message.id,
    };
    if (params) body.params = params;
    const res = await this.#app('/api/chat/v1', body, 'text/event-stream');
    const out = await parseStream(res, onChunk);
    return { ...out, model: out.model ?? model, conversationId: conv };
  }

  /**
   * Text-to-image through the dedicated endpoint (2/day per account on the free plan).
   * If that quota answers 429 the same prompt is rendered through the chat route, which draws on the
   * chat quota instead — pass `viaChat: false` to opt out, `viaChat: true` to always use that route.
   * @param {string} prompt
   * @param {object} [o]
   * @param {string} [o.model]    an image model (see ai.models(), output_modalities includes 'image')
   * @param {string} [o.save]     write the PNG here
   * @param {boolean|'auto'} [o.viaChat]
   */
  async image(prompt, { model = MODELS.image, save, viaChat = 'auto' } = {}) {
    await this.#ready;
    try {
      const out = await this.#app('/api/image-generation', { prompt, model });
      const item = out.data?.[0];
      if (!item) throw new UltraAIError('no image in response', 'empty_response');
      const buffer = item.b64_json
        ? Buffer.from(item.b64_json, 'base64')
        : Buffer.from(await (await fetch(item.url)).arrayBuffer());
      const result = { buffer, url: item.url, mime: item.mime ?? 'image/png', revisedPrompt: item.revised_prompt, model };
      if (save) await saveMedia(result, save);
      return result;
    } catch (err) {
      const quota = err.status === 429 || /usage limit/i.test(err.message ?? '');
      if (viaChat === false || (!quota && viaChat !== true)) throw err;
      return this.#imageViaChat(prompt, { model, save, cause: err });
    }
  }

  async #imageViaChat(prompt, { model, save, cause }) {
    const out = await this.chat(prompt, { model });
    const url = out.images?.[0]?.url;
    if (!url) throw cause;
    return this.#media(url, { model, save, viaChat: true, text: out.text });
  }

  /** authenticated asset download (/api/assets/get/…) */
  async #media(url, { model, save, mime, text, conversationId, viaChat } = {}) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.#token()}` } });
    if (!res.ok) throw new UltraAIError(`asset download ${res.status}`, 'asset_failed', res.status);
    const result = {
      buffer: Buffer.from(await res.arrayBuffer()),
      url,
      mime: mime ?? res.headers.get('content-type') ?? 'application/octet-stream',
      model,
    };
    if (text !== undefined) result.text = text;
    if (conversationId) result.conversationId = conversationId;
    if (viaChat) result.viaChat = true;
    if (save) await saveMedia(result, save);
    return result;
  }

  /**
   * Text-to-video through the app's `video-generation` tool (1/day per account on the free plan).
   * The job is asynchronous: the app re-sends the same turn until the stream carries the clip, so this
   * polls on the interval the server itself asks for (`pollConfig.interval`) until the asset shows up.
   * @param {string} prompt
   * @param {object} [o]
   * @param {string} [o.model]       a video model: ai.models() filtered by output_modalities includes 'video'
   * @param {string} [o.resolution]  '480p' (free-tier default) | '720p' | '1080p'
   * @param {string} [o.aspectRatio] '9:16' | '16:9' | '1:1'
   * @param {number} [o.length]      seconds the clip should run
   * @param {string} [o.save]        write the mp4 here
   * @param {number} [o.timeout]     give up after this many ms (default 15 min, same deadline as the app)
   * @param {number} [o.attempts]   how many times to resubmit while the tool route refuses the turn
   * @param {(info: {phase: 'submit'|'poll', attempt: number, interval: number}) => void} [o.onProgress]
   */
  async video(prompt, { model = MODELS.video, resolution = '480p', aspectRatio = '9:16', length = 5, save,
    timeout = 900000, interval, attempts = 8, onProgress } = {}) {
    await this.#ready;
    const deadline = Date.now() + timeout;
    const newTurn = () => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      return {
        model,
        webSearch: false,
        conversation_id: conversationId,
        slugType: 'tool',
        slug: MODELS.videoTool,
        userPreferences: {},
        streamAudio: false,
        params: {
          toolSettings: { length, resolution, aspectRatio },
          settings: { length: 'auto', tone: 'default' },
        },
        message: { id: messageId, role: 'user', content: prompt, createdAt: new Date().toISOString(), requestStartTime: Date.now() },
        sub_conversation_id: conversationId,
        query_id: messageId,
        sendEmail: true,        // these two match the app's own payload; the tool route 400s without them
        followupQuesGen: true,
      };
    };

    // Phase 1 — get the job accepted. The tool route intermittently answers 400 to a well-formed body, so a
    // rejection only costs a fresh turn id, never the daily quota.
    let job = null;
    let wait = interval;
    let refusal = '';
    for (let i = 1; i <= attempts && !job; i++) {
      onProgress?.({ phase: 'submit', attempt: i, interval: wait ?? 0 });
      const turn = newTurn();
      const res = await this.#app('/api/chat/v1', turn, 'text/event-stream', { soft: true });
      refusal = res.ok ? '' : `${res.status} ${errorCode(await res.clone().text().catch(() => ''))}`;
      if (res.status === 429) {
        const detail = await res.text().catch(() => '');
        throw new UltraAIError(quotaText(detail), errorCode(detail), 429);
      }
      if (!res.ok) {
        await res.text().catch(() => '');
        await sleep(refusalDelay);
        continue;
      }
      const out = await parseStream(res);
      const url = assetUrl(out);
      if (url) return this.#media(url, { model, save, text: out.text, conversationId: turn.conversation_id });
      if (out.pollInterval || out.text.trim()) {
        job = turn;                                   // accepted: from now on every request is a poll
        wait = interval ?? out.pollInterval ?? 5000;
      } else {
        await sleep(refusalDelay);
      }
    }
    if (!job) {
      throw new UltraAIError(`the video tool rejected ${attempts} requests in a row (last: ${refusal}) — it does this ` +
        'in bursts; retrying later usually gets through', 'video_rejected');
    }

    // Phase 2 — poll the same turn until the clip exists. Transient 4xx/5xx mid-render are not fatal.
    for (;;) {
      await sleep(wait);
      if (Date.now() >= deadline) throw new UltraAIError(`video still rendering after ${Math.round(timeout / 1000)}s`, 'video_timeout');
      onProgress?.({ phase: 'poll', attempt: 0, interval: wait });
      const res = await this.#app('/api/chat/v1', job, 'text/event-stream', { soft: true });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 429) throw new UltraAIError(quotaText(detail), errorCode(detail), 429);
        continue;
      }
      const out = await parseStream(res);
      const url = assetUrl(out);
      if (url) return this.#media(url, { model, save, text: out.text, conversationId: job.conversation_id });
      if (out.pollInterval) wait = interval ?? out.pollInterval;
    }
  }

  // ---------------------------------------------------------------- auth

  async #register() {
    await this.#clerk('client', undefined, 'GET');
    let last;
    for (let i = 0; i < this.opts.aliases; i++) {
      const email = this.opts.email ?? (await tempEmail({ providers: this.opts.provider }));
      const t0 = Date.now();
      try {
        const su = await this.#clerk('client/sign_ups', {
          email_address: email,
          first_name: this.opts.firstName,
          last_name: this.opts.lastName,
          legal_accepted: 'true',   // this instance has legal_consent_enabled
        });
        await this.#clerk(`client/sign_ups/${su.response.id}/prepare_verification`, { strategy: 'email_code' });
        const code = await this.#waitCode(email, t0);
        const done = await this.#clerk(`client/sign_ups/${su.response.id}/attempt_verification`, {
          strategy: 'email_code',
          code,
        });
        if (done.response.status !== 'complete') throw new UltraAIError(`signup ${done.response.status}`, 'signup_incomplete');
        return this.#adopt(email, done.response.created_session_id, done.response.created_user_id);
      } catch (err) {
        last = err;
        // address already tied to a user, or this client still holds a session -> next alias
        if (!['not_allowed_access', 'form_identifier_exists', 'session_exists'].includes(err.code)) throw err;
        this.#jwt = null;
        this.#sessionId = null;
      }
    }
    throw last ?? new UltraAIError('registration failed', 'register_failed');
  }

  async #login(email) {
    await this.#clerk('client', undefined, 'GET');
    const t0 = Date.now();
    const si = await this.#clerk('client/sign_ins', { identifier: email });
    const factor = (si.response.supported_first_factors ?? [])[0] ?? {};
    await this.#clerk(`client/sign_ins/${si.response.id}/prepare_first_factor`, {
      strategy: 'email_code',
      email_address_id: factor.email_address_id,     // required, else form_conditional_param_missing
    });
    const code = await this.#waitCode(email, t0);
    const done = await this.#clerk(`client/sign_ins/${si.response.id}/attempt_first_factor`, {
      strategy: 'email_code',
      code,
    });
    if (done.response.status !== 'complete') throw new UltraAIError(`login ${done.response.status}`, 'login_incomplete');
    return this.#adopt(email, done.response.created_session_id, done.response.created_user_id);
  }

  async #adopt(email, sessionId, userId) {
    this.#email = email;
    this.#sessionId = sessionId;
    this.#userId = userId ?? null;
    await this.#token();          // fails early if the session is not usable
    return this;
  }

  async #waitCode(email, since) {
    const deadline = Date.now() + (this.opts.codeTimeout ?? 180000);
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${TEMPMAIL}/api/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': UA },
          body: JSON.stringify({ email, wait: false }),
          signal: AbortSignal.timeout(30000),
        });
        const { data = [] } = await res.json();
        let best = null;
        for (const m of data) {
          // a pool inbox holds other people's codes too: newest ultrachatai mail after we asked
          if (!`${m.from}${m.subject}`.toLowerCase().includes('ultrachatai')) continue;
          const ts = Date.parse(m.date);
          if (Number.isFinite(ts) && ts < since - 5000) continue;
          const hit = /\b(\d{6})\b/.exec(m.subject ?? '');
          if (hit && (!best || ts > best[0])) best = [ts, hit[1]];
        }
        if (best) return best[1];
      } catch { /* inbox hiccup — keep polling */ }
      await sleep(8000);
    }
    throw new UltraAIError(`no verification code for ${email}`, 'code_timeout');
  }

  async #token() {
    if (this.#jwt && Date.now() - this.#jwtAt < 45000) return this.#jwt;   // Clerk JWTs last ~60s
    if (!this.#sessionId) throw new UltraAIError('not signed in', 'no_session');
    const res = await this.#clerk(`client/sessions/${this.#sessionId}/tokens`, {});
    const jwt = (res.response ?? res).jwt;                                  // this one answers bare
    if (!jwt) throw new UltraAIError('no session token', 'token_failed');
    this.#jwt = jwt;
    this.#jwtAt = Date.now();
    return jwt;
  }

  // ---------------------------------------------------------------- http

  async #clerk(path, form, method = 'POST') {
    const url = `${CLERK}/v1/${path}${path.includes('?') ? '&' : '?'}_clerk_js_version=${CLERK_JS}`;
    return this.#json(url, { form, method });
  }

  async #app(path, body, accept = 'application/json', opts = {}) {
    const jwt = await this.#token();
    return this.#json(APP + path, {
      json: body,
      redirect: 'follow',
      ...opts,
      method: body === undefined ? 'GET' : 'POST',
      accept,
      // the tool routes 400 a well-formed turn unless the referer looks like an app page
      headers: { authorization: `Bearer ${jwt}`, referer: `${APP}/app/` },
      raw: accept !== 'application/json',
    });
  }

  /** @returns {Promise<any>} parsed body (or the raw Response when raw) */
  async #json(url, { form, json, method = 'POST', accept = 'application/json', headers = {}, raw = false, soft = false, redirect = 'manual' } = {}) {
    const h = {
      'user-agent': UA,
      accept,
      origin: APP,
      referer: `${APP}/`,
      ...headers,
    };
    if (this.#cookies.size) h.cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded';   // Clerk ignores JSON bodies
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(url, { method, headers: h, body, redirect });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.#cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
    if (raw) {
      if (!res.ok && !soft) throw new UltraAIError(`${url} -> HTTP ${res.status}`, errorCode(await res.text()), res.status);
      return res;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UltraAIError(`${url} -> HTTP ${res.status}: ${text.slice(0, 120)}`, 'bad_response', res.status);
    }
    if (!res.ok) {
      const e = data.errors?.[0] ?? data;
      throw new UltraAIError(e.longMessage ?? e.message ?? data.error ?? `HTTP ${res.status}`,
        e.code ?? data.code ?? data.error, res.status);
    }
    return data;
  }
}

async function saveMedia(result, path) {
  await writeFile(path, result.buffer);
  result.path = path;
  return result;
}

const refusalDelay = 5000;   // the tool route refuses in bursts, so space the resubmits out

function assetUrl(out) {
  const cands = [...(out.videos ?? []).map((v) => v?.url), ...(out.images ?? []).map((i) => i?.url), ...out.urls].filter(Boolean);
  return cands.find((u) => /\.(mp4|webm|mov)(\?|$)/i.test(u)) ?? cands[0] ?? null;
}

function quotaText(detail) {
  try {
    return JSON.parse(detail).message ?? 'usage limit exceeded';
  } catch {
    return detail.slice(0, 140) || 'usage limit exceeded';
  }
}

function errorCode(text) {
  try {
    const j = JSON.parse(text);
    return j.code ?? j.error ?? `http_${j.status ?? ''}`;
  } catch {
    return 'http_error';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** the app streams `f:{...}` / `0:"text"` / `e:{...}` / `d:{...}` lines */
async function parseStream(res, onChunk) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let markdown = '';
  let deltas = '';
  let images = [];
  let videos = [];
  let urls = [];
  let pollInterval = null;
  let usage = null;
  let model = null;
  const line = (raw) => {
    for (const u of raw.match(/https?:\/\/[^"'\\\s)]+/g) ?? []) {           // generated assets
      if (!/\/(images|_next|fonts)\//.test(u) && !/storage\.googleapis\.com\/pleasantly/.test(u) && !urls.includes(u)) urls.push(u);
    }
    const m = /^([0-9a-z]+):(.*)$/s.exec(raw);
    if (!m) return;
    let v;
    try {
      v = JSON.parse(m[2]);
    } catch {
      return;
    }
    if (m[1] === '0' && typeof v === 'string') {
      markdown += v;
      onChunk?.(v);
      return;
    }
    if (v && typeof v === 'object') {
      if (v.model) model = v.model;
      const piece = v.choices?.[0]?.delta?.content;
      if (typeof piece === 'string' && piece) {
        deltas += piece;
        onChunk?.(piece);
      }
      if (Array.isArray(v.images) && v.images.length) images = v.images;
      if (Array.isArray(v.videos) && v.videos.length) videos = v.videos;
      if (v.usage) usage = v.usage;
      if (v.pollConfig?.interval) pollInterval = v.pollConfig.interval;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) line(l.trim());
  }
  if (buf.trim()) line(buf.trim());
  return { text: markdown || deltas, images, videos, urls, pollInterval, usage };
}

export default UltraAI;
