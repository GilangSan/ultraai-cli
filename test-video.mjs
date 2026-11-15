import { UltraAI } from './index.js';

const ai = new UltraAI();
await ai.ready();
console.log('account:', ai.email);

const t0 = Date.now();
const v = await ai.video('a paper plane gliding over a lake at sunset, cinematic', {
  save: './clip.mp4',
  onProgress: (i) => console.log(`  poll #${i.attempt}`),
});
console.log(`VIDEO ${v.buffer.length} bytes -> ${v.path} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('url:', v.url);
