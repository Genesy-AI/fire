const ALLOWED_PATHS = new Set(["/slack/events", "/slack/interaction"]);

export interface Env {
	INCIDENTD: Fetcher;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!ALLOWED_PATHS.has(url.pathname)) {
			return new Response("Not found", { status: 404 });
		}

		url.hostname = "incidentd";
		return env.INCIDENTD.fetch(new Request(url, request));
	},
} satisfies ExportedHandler<Env>;
