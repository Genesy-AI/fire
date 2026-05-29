import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import viteTsConfigPaths from "vite-tsconfig-paths";

const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
	server: {
		allowedHosts: ["glowing-externally-sloth.ngrok-free.app"],
	},
	plugins: [
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
