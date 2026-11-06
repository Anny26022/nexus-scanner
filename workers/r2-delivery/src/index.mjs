import { WorkerEntrypoint } from 'cloudflare:workers';
import { gateway, serveObject } from './delivery.mjs';

/** Published objects, cached by Workers Cache (exports.CachedDelivery in wrangler.jsonc). */
export class CachedDelivery extends WorkerEntrypoint {
  fetch(request) {
    return serveObject(request, this.env);
  }
}

/** Uncached: decides access on every request, then reads through the cached entrypoint. */
export default {
  fetch(request, env, ctx) {
    return gateway(request, env, (forwarded) => ctx.exports.CachedDelivery.fetch(forwarded));
  },
};
