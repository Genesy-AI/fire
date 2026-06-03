import { type Context, Hono } from "hono";
import { STANDARD_CACHE, withCache } from "./lib/cache";
import { withRequestDb } from "./lib/db";
import {
	buildIntercomCanvasContentResponseByStatusPageId,
	buildIntercomInboxCanvasInitializeResponse,
	buildIntercomLiveCanvasInitializeResponse,
	verifyIntercomSignature,
} from "./lib/intercom.server";
import { buildStatusSnapshotResponse } from "./lib/status-pages.api";
import { buildHistoryFeedResponse, type FeedFormat } from "./lib/status-pages.feed";
import { buildIncidentDetailResponse, buildIncidentHistoryResponse, buildStatusPageResponse } from "./lib/status-pages.render";
import {
	fetchIncidentDetailByDomain,
	fetchIncidentDetailBySlug,
	fetchIncidentHistoryByDomain,
	fetchIncidentHistoryBySlug,
	fetchPublicStatusPageByDomain,
	fetchPublicStatusPageBySlug,
	fetchStatusSnapshotByDomain,
	fetchStatusSnapshotBySlug,
} from "./lib/status-pages.server";
import { normalizeDomain } from "./lib/status-pages.utils";

const app = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

app.use("*", async (c, next) => {
	await withRequestDb(c.env.DB.connectionString, next);
});

function getHost(c: AppContext): string | null {
	const rawHost = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]?.trim() ?? "";
	return normalizeDomain(rawHost);
}

function getOrigin(c: AppContext): string {
	const rawHost = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]?.trim() ?? "";
	const protocol = c.req.header("x-forwarded-proto") ?? "https";
	return `${protocol}://${rawHost}`;
}

function parseFeedFormat(feed: string): FeedFormat | null {
	if (feed === "feed.rss") return "rss";
	if (feed === "feed.atom") return "atom";
	return null;
}

// --- Domain-based routes ---

app.get("/", async (c) => {
	const host = getHost(c);
	if (!host) return c.text("Not found", 404);

	const data = await fetchPublicStatusPageByDomain(host);
	if (!data) return c.text("Not found", 404);

	return buildStatusPageResponse(data);
});

app.get("/history", async (c) => {
	const host = getHost(c);
	if (!host) return c.text("Not found", 404);

	const data = await fetchIncidentHistoryByDomain(host);
	if (!data) return c.text("Not found", 404);

	return buildIncidentHistoryResponse(data);
});

app.get("/history/:id", async (c) => {
	const host = getHost(c);
	if (!host) return c.text("Not found", 404);

	const { id } = c.req.param();
	const data = await fetchIncidentDetailByDomain(host, id);
	if (!data) return c.text("Not found", 404);

	return buildIncidentDetailResponse(data, !data.incident.resolvedAt);
});

app.get("/api/status", async (c) => {
	const host = getHost(c);
	if (!host) return c.text("Not found", 404);

	const snapshot = await fetchStatusSnapshotByDomain(host);
	if (!snapshot) return c.text("Not found", 404);

	return buildStatusSnapshotResponse({ snapshot });
});

// --- Intercom routes (POST, registered before /:slug wildcard) ---

app.post("/api/intercom/canvas/initialize/inbox", async (c) => {
	const rawBody = await c.req.text();
	const signature = c.req.header("x-body-signature") ?? null;
	if (!verifyIntercomSignature(rawBody, signature)) return c.text("Invalid signature", 401);

	const response = await buildIntercomInboxCanvasInitializeResponse(rawBody);
	if (response.status !== 200) return c.text("Not found", response.status);

	return c.json(response.response);
});

app.post("/api/intercom/canvas/initialize", async (c) => {
	const rawBody = await c.req.text();
	const signature = c.req.header("x-body-signature") ?? null;
	if (!verifyIntercomSignature(rawBody, signature)) return c.text("Invalid signature", 401);

	const response = await buildIntercomLiveCanvasInitializeResponse(rawBody);
	if (response.status !== 200) return c.text("Not found", response.status);

	return c.json(response.response);
});

app.post("/intercom/:statusPageId", async (c) => {
	const { statusPageId } = c.req.param();
	const response = await withCache(`intercom:${statusPageId}`, STANDARD_CACHE, () => buildIntercomCanvasContentResponseByStatusPageId(statusPageId));
	if (response.status !== 200) return c.text("Not found", 404);

	return c.json(response.response);
});

// --- Slug-based routes (PRIMARY_DOMAIN only) ---
// Specific sub-paths registered before /:slug/:feed to ensure correct matching

app.get("/:slug/history/:id", async (c) => {
	const primaryDomain = process.env.STATUS_PAGE_DOMAIN ?? "";
	if (!primaryDomain) return c.text("Configuration error", 500);
	if (getHost(c) !== primaryDomain) return c.text("Not found", 404);

	const { slug, id } = c.req.param();
	const data = await fetchIncidentDetailBySlug(slug, id);
	if (!data) return c.text("Not found", 404);

	return buildIncidentDetailResponse(data, !data.incident.resolvedAt);
});

app.get("/:slug/history", async (c) => {
	const primaryDomain = process.env.STATUS_PAGE_DOMAIN ?? "";
	if (!primaryDomain) return c.text("Configuration error", 500);
	if (getHost(c) !== primaryDomain) return c.text("Not found", 404);

	const { slug } = c.req.param();
	const data = await fetchIncidentHistoryBySlug(slug);
	if (!data) return c.text("Not found", 404);

	return buildIncidentHistoryResponse(data, `/${slug}`);
});

app.get("/:slug/api/status", async (c) => {
	const primaryDomain = process.env.STATUS_PAGE_DOMAIN ?? "";
	if (!primaryDomain) return c.text("Configuration error", 500);
	if (getHost(c) !== primaryDomain) return c.text("Not found", 404);

	const { slug } = c.req.param();
	const snapshot = await fetchStatusSnapshotBySlug(slug);
	if (!snapshot) return c.text("Not found", 404);

	return buildStatusSnapshotResponse({ snapshot });
});

app.get("/:slug/:feed", async (c) => {
	const primaryDomain = process.env.STATUS_PAGE_DOMAIN ?? "";
	if (!primaryDomain) return c.text("Configuration error", 500);
	if (getHost(c) !== primaryDomain) return c.text("Not found", 404);

	const { slug, feed } = c.req.param();
	const format = parseFeedFormat(feed);
	if (!format) return c.text("Not found", 404);

	const data = await fetchIncidentHistoryBySlug(slug);
	if (!data) return c.text("Not found", 404);

	const origin = getOrigin(c);
	const siteUrl = new URL(`/${slug}`, origin).toString();
	const feedUrl = new URL(`/${slug}/${feed}`, origin).toString();

	return buildHistoryFeedResponse({ data, format, feedUrl, siteUrl });
});

app.get("/:slug", async (c) => {
	const primaryDomain = process.env.STATUS_PAGE_DOMAIN ?? "";
	if (!primaryDomain) return c.text("Configuration error", 500);

	const host = getHost(c);
	if (!host) return c.text("Not found", 404);

	const { slug } = c.req.param();

	// Feed access from a custom domain: /feed.rss or /feed.atom
	const feedFormat = parseFeedFormat(slug);
	if (feedFormat && host !== primaryDomain) {
		const data = await fetchIncidentHistoryByDomain(host);
		if (!data) return c.text("Not found", 404);

		const origin = getOrigin(c);
		const siteUrl = new URL("/", origin).toString();
		const feedUrl = new URL(`/${slug}`, origin).toString();

		return buildHistoryFeedResponse({ data, format: feedFormat, feedUrl, siteUrl });
	}

	if (host !== primaryDomain) return c.text("Not found", 404);

	const data = await fetchPublicStatusPageBySlug(slug);
	if (!data) return c.text("Not found", 404);

	return buildStatusPageResponse(data, `/${slug}`);
});

export default app;
