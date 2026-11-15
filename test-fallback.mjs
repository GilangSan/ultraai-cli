/**
 * Verifies the new bits: image() auto-fallback once the 2/day image quota is gone, and video().
 *   node test-fallback.mjs
 */
import { UltraAI, MODELS, UltraAIError } from './index.js';

const ai = new UltraAI();
await ai.ready();
console.log('account:', ai.email);

for (let i = 1; i <= 3; i++) {
  const r = await ai.image(`a red apple, variant ${i}`, { save: `fallback-${i}.png` });
  console.log(`image #${i}: ${r.buffer.length} bytes | viaChat=${!!r.viaChat} | ${r.path}`);
}

console.log('\nforcing the chat route too:');
const forced = await ai.image('a blue mug', { viaChat: true, save: 'fallback-forced.png' });
console.log(`  ${forced.buffer.length} bytes | viaChat=${!!forced.viaChat} | ${forced.path}`);

console.log('\nvideo():');
try {
  const v = await ai.video('a paper plane gliding over a lake, cinematic', { save: 'clip.mp4' });
  console.log('  got', v.buffer.length, 'bytes ->', v.path);
} catch (err) {
  console.log('  ' + (err instanceof UltraAIError ? `UltraAIError(${err.code}): ${err.message}` : err));
}
