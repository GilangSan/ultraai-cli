// Which advertised models does the free plan actually serve? One pass, 7 accounts:
// each account gives 10 chat turns + 2 images + 1 video, so every candidate fits.
import { UltraAI, UltraAIError } from './index.js';

const t0 = Date.now();
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const accounts = [];
async function account(i) {
  if (accounts[i]) return accounts[i];
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const ai = new UltraAI();
      await ai.ready();
      accounts[i] = ai;
      note(`#${i + 1} ready: ${ai.email}`);
      return ai;
    } catch (e) {
      if (e.status !== 429) throw e;
      note(`#${i + 1} register 429, waiting 30s (attempt ${attempt})`);
      await sleep(30000);
    }
  }
  throw new Error('could not register account #' + (i + 1));
}

const probe = async (ai, kind, m) => {
  try {
    if (kind === 'chat') {
      const r = await ai.chat('say ok', { model: m.id });
      return r.text?.trim() ? `ok (${r.text.trim().slice(0, 20)})` : 'empty reply';
    }
    if (kind === 'image') {
      const r = await ai.image('a red apple on a wooden table', { model: m.id, viaChat: false });
      return `ok (${(r.buffer.length / 1024).toFixed(0)} KB)`;
    }
    await ai.video('a paper plane gliding over a lake', { model: m.id, attempts: 1, timeout: 20000, interval: 5000 });
    return 'ok (clip returned)';
  } catch (e) {
    if (e.code === 'video_timeout') return 'accepted (renders ~70s)';
    return `${e.code ?? 'error'}${e.status ? ' HTTP ' + e.status : ''}: ${(e.message ?? '').slice(0, 70)}`;
  }
};

const first = await account(0);
const listed = await first.models();
const models = Array.isArray(listed) ? listed : (listed.data ?? listed.models ?? []);
const has = (m, k) => (m.output_modalities ?? []).includes(k);
const pick = (k) => models.filter((m) => m.access !== false && has(m, k) && !(m.premium));
const chat = pick('text'), image = pick('image'), video = pick('video');
note(`candidates: chat ${chat.length}, image ${image.length}, video ${video.length} (of ${models.length} listed)`);

const out = { chat: {}, image: {}, video: {} };

for (let i = 0; i < chat.length; i++) {
  const ai = await account(Math.floor(i / 10));
  const m = chat[i];
  out.chat[m.id] = await probe(ai, 'chat', m);
  note(`chat ${m.id}: ${out.chat[m.id]}`);
}
for (let i = 0; i < image.length; i++) {
  const ai = await account(Math.floor(i / 2));
  const m = image[i];
  out.image[m.id] = await probe(ai, 'image', m);
  note(`image ${m.id}: ${out.image[m.id]}`);
}
for (let i = 0; i < video.length; i++) {
  const ai = await account(i);
  const m = video[i];
  out.video[m.id] = await probe(ai, 'video', m);
  note(`video ${m.id}: ${out.video[m.id]}`);
}

console.log('\n=========== SUMMARY\n' + JSON.stringify(out, null, 1));
