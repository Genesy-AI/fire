/**
 * Node.js ESM loader hook that stubs out cloudflare: built-in modules.
 * Registered during `vite build` so TanStack Start's prerender step (which
 * dynamically imports the SSR/Worker bundle in plain Node.js) can load the
 * bundle without hitting ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * At runtime in Cloudflare Workers, this file is never loaded — the Worker
 * runtime provides real cloudflare: modules as built-ins.
 */

export function resolve(specifier, _context, nextResolve) {
	if (specifier.startsWith("cloudflare:")) {
		// Keep the URL as-is; our load hook will intercept it below.
		return { url: specifier, shortCircuit: true };
	}
	return nextResolve(specifier);
}

export function load(url, _context, nextLoad) {
	if (url.startsWith("cloudflare:")) {
		return {
			format: "module",
			source: `
export class WorkflowEntrypoint {}
export class DurableObject {}
export class RpcTarget {}
export const env = {};
`,
			shortCircuit: true,
		};
	}
	return nextLoad(url);
}
