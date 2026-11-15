/**
 * Runnable check:  node test.js
 * Registers a throwaway account, then exercises every public method.
 */
import { UltraAI, MODELS, UltraAIError } from './index.js';
import { stat } from 'node:fs/promises';

const ai = new UltraAI();                       // no await: registration starts here
console.log('registering a fresh account …');

const user = await ai.user();
console.log('account   :', ai.email, ai.userId);
console.log('plan      :', user.planName);
console.log('limits    :', JSON.stringify(user.rateLimitConfig));

const models = await ai.models();
const imageModels = models.filter((m) => (m.output_modalities ?? []).includes('image')).map((m) => m.id);
console.log('models    :', models.length, '| image:', imageModels.join(', '));
console.assert(models.length > 0, 'expected a model list');

const reply = await ai.chat('Say hi in exactly 5 words.');
console.log('chat      :', JSON.stringify(reply.text), '| served by', reply.model);
console.assert(reply.text.length > 0, 'expected chat text');

const follow = await ai.chat('How many words was that?', { conversationId: reply.conversationId });
console.log('follow-up :', JSON.stringify(follow.text));

const img = await ai.image('a red apple on a rustic wooden table, studio light', { save: 'test-image.png' });
console.log('image     :', img.mime, img.buffer.length, 'bytes ->', img.path, '|', (await stat(img.path)).size, 'on disk');
console.assert(img.buffer.length > 10000, 'expected a real png');

try {
  await ai.image('nope', { model: MODELS.auto });   // text model on the image route -> API 500
  console.error('expected the text-model call to fail');
} catch (err) {
  console.log('guard     :', err instanceof UltraAIError ? `UltraAIError(${err.code}) ${err.message}` : err);
}

console.log('\nOK');
