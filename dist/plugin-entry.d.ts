/**
 * dsh-chat-interaction/plugin — the DSH-bound half of the layer.
 *
 * This entry is for running INSIDE DeepSeek Harness: it wires the official
 * runtime APIs (createUserMessage / defineTool / installModelSelection) into
 * the interaction layer. Load it as a cordis plugin:
 *
 *   import { apply, name, inject } from 'dsh-chat-interaction/plugin'
 *   export { apply, name, inject }
 *
 * (or mount it through the bundled cordis.patch.yml under id `chatInteraction`).
 *
 * The core entry (`dsh-chat-interaction`) stays harness-free: hub, channels,
 * scoring, approval — everything that does not touch the agent runtime.
 * @module dsh-chat-interaction/plugin-entry
 */
export * from './plugin.js';
export * from './harness.js';
export * from './model-selection.js';
export * from './session-events.js';
