// Public API of the MAX messenger integration: outbound transport, keyboards, inbound normalization.
export { MaxClient, TransportFailure } from './client.js';
export type { MaxTransport } from './client.js';
export { consentKeyboard } from './keyboard.js';
export { normalizeUpdate } from './normalize.js';
