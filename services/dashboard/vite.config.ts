import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { workflow } from "workflow/vite";

try {
	const devVars = readFileSync(".dev.vars", "utf8");
	for (const line of devVars.split("\n")) {
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1 || line.trimStart().startsWith("#")) continue;
		const key = line.slice(0, eqIdx).trim();
		const val = line.slice(eqIdx + 1).trim();
		process.env[key] ??= val;
	}
} catch {}

const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
	server: {
		allowedHosts: ["glowing-externally-sloth.ngrok-free.app"],
	},
	plugins: [
		workflow(),
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
		nitro({ preset: "cloudflare_pages" }),
	],
});
