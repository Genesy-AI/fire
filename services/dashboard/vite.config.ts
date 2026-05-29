import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import viteTsConfigPaths from "vite-tsconfig-paths";

const isProd = process.env.NODE_ENV === "production";

// Registers a Node.js ESM loader hook so TanStack Start's prerender step can
// import the Cloudflare Worker SSR bundle without hitting
// ERR_UNSUPPORTED_ESM_URL_SCHEME on bare `cloudflare:` imports.
// The loader is only active during `vite build` — it never ships to production.
function cloudflareNodeCompatPlugin(): Plugin {
	let registered = false;
	return {
		name: "cloudflare-node-compat",
		enforce: "pre",
		async buildStart() {
			if (registered) return;
			registered = true;
			const { register } = await import("node:module");
			const loaderUrl = new URL("./cloudflare-prerender-loader.mjs", import.meta.url).href;
			register(loaderUrl);
		},
	};
}

export default defineConfig({
	server: {
		allowedHosts: ["glowing-externally-sloth.ngrok-free.app"],
	},
	environments: {
		client: {
			build: {
				rollupOptions: {
					external: (id) => id.startsWith("cloudflare:"),
				},
			},
		},
	},
	plugins: [
		cloudflareNodeCompatPlugin(),
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		!isProd && devtools(),
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
		tailwindcss(),
		tanstackStart({
			spa: {
				enabled: true,
			},
		}),
		solidPlugin({ ssr: true }),
	],
});
