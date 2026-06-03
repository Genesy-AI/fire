import {
	client as clientTable,
	incidentAffectionService as incidentAffectionServiceTable,
	incidentAffection as incidentAffectionTable,
	type incidentAffectionUpdate as incidentAffectionUpdateTable,
	service as serviceTable,
	statusPageService as statusPageServiceTable,
	statusPage as statusPageTable,
} from "@fire/db/schema";
import { and, eq, type InferSelectModel } from "drizzle-orm";
import { SNAPSHOT_CACHE, STANDARD_CACHE, withCache } from "./cache";
import { db } from "./db";
import { normalizeDomain } from "./status-pages.utils";

type StatusPageRow = InferSelectModel<typeof statusPageTable>;
type ServiceRow = InferSelectModel<typeof serviceTable>;
type IncidentAffectionRow = InferSelectModel<typeof incidentAffectionTable>;
type IncidentAffectionServiceRow = InferSelectModel<typeof incidentAffectionServiceTable>;
type IncidentAffectionUpdateRow = InferSelectModel<typeof incidentAffectionUpdateTable>;

type StatusPageLookup = { slug: string } | { domain: string };

type StatusPageContentRow = Pick<
	StatusPageRow,
	| "id"
	| "clientId"
	| "name"
	| "slug"
	| "logoUrl"
	| "faviconUrl"
	| "serviceDisplayMode"
	| "siteUrl"
	| "privacyPolicyUrl"
	| "supportUrl"
	| "termsOfServiceUrl"
	| "createdAt"
	| "updatedAt"
>;

type StatusPageContentWithClientRow = StatusPageContentRow & { clientImage: string | null };

export type StatusPageService = Pick<ServiceRow, "id" | "name" | "imageUrl"> & {
	position: number | null;
	createdAt: Date | null;
	description: string | null;
};

export type StatusPageSummary = Pick<
	StatusPageRow,
	"id" | "name" | "slug" | "logoUrl" | "faviconUrl" | "serviceDisplayMode" | "siteUrl" | "supportUrl" | "privacyPolicyUrl" | "termsOfServiceUrl" | "createdAt" | "updatedAt"
> & {
	clientImage: string | null;
};

export type StatusPageAffection = Pick<IncidentAffectionRow, "id" | "incidentId" | "title" | "createdAt" | "updatedAt" | "resolvedAt"> & {
	services: { id: ServiceRow["id"]; impact: IncidentAffectionServiceRow["impact"] }[];
};

export type StatusPageAffectionUpdate = Pick<IncidentAffectionUpdateRow, "id" | "affectionId" | "status" | "message" | "createdAt" | "createdBy">;

export type StatusPagePublicData = {
	page: StatusPageSummary;
	services: StatusPageService[];
	affections: StatusPageAffection[];
	updates: StatusPageAffectionUpdate[];
};

function sortStatusPageServices(services: StatusPageService[]) {
	return [...services].sort((a, b) => {
		if (a.position == null && b.position == null) {
			return a.name.localeCompare(b.name);
		}
		if (a.position == null) return 1;
		if (b.position == null) return -1;
		if (a.position !== b.position) return a.position - b.position;
		return a.name.localeCompare(b.name);
	});
}

function buildStatusPageSummary(pageRow: StatusPageContentRow, clientImage: string | null): StatusPageSummary {
	return {
		id: pageRow.id,
		name: pageRow.name,
		slug: pageRow.slug,
		logoUrl: pageRow.logoUrl,
		faviconUrl: pageRow.faviconUrl,
		serviceDisplayMode: pageRow.serviceDisplayMode,
		siteUrl: pageRow.siteUrl,
		supportUrl: pageRow.supportUrl,
		privacyPolicyUrl: pageRow.privacyPolicyUrl,
		termsOfServiceUrl: pageRow.termsOfServiceUrl,
		createdAt: pageRow.createdAt,
		updatedAt: pageRow.updatedAt,
		clientImage,
	};
}

function resolveStatusPageLookupFilter(lookup: StatusPageLookup) {
	if ("slug" in lookup) {
		return eq(statusPageTable.slug, lookup.slug);
	}

	const normalizedDomain = normalizeDomain(lookup.domain);
	if (!normalizedDomain) {
		return null;
	}

	return eq(statusPageTable.customDomain, normalizedDomain);
}

async function findStatusPageContentWithClientRow(lookup: StatusPageLookup): Promise<StatusPageContentWithClientRow | null> {
	const whereFilter = resolveStatusPageLookupFilter(lookup);
	if (!whereFilter) {
		return null;
	}

	const rows = await db
		.select({
			id: statusPageTable.id,
			clientId: statusPageTable.clientId,
			name: statusPageTable.name,
			slug: statusPageTable.slug,
			logoUrl: statusPageTable.logoUrl,
			faviconUrl: statusPageTable.faviconUrl,
			serviceDisplayMode: statusPageTable.serviceDisplayMode,
			siteUrl: statusPageTable.siteUrl,
			privacyPolicyUrl: statusPageTable.privacyPolicyUrl,
			supportUrl: statusPageTable.supportUrl,
			termsOfServiceUrl: statusPageTable.termsOfServiceUrl,
			createdAt: statusPageTable.createdAt,
			updatedAt: statusPageTable.updatedAt,
			clientImage: clientTable.image,
		})
		.from(statusPageTable)
		.leftJoin(clientTable, eq(clientTable.id, statusPageTable.clientId))
		.where(whereFilter)
		.limit(1);

	return rows[0] ?? null;
}

async function buildStatusPagePublicData(pageRow: StatusPageContentWithClientRow): Promise<StatusPagePublicData> {
	const serviceLinks = await db.query.statusPageService.findMany({
		where: { statusPageId: pageRow.id },
		columns: { position: true, description: true },
		with: {
			service: {
				columns: { id: true, name: true, imageUrl: true, createdAt: true },
			},
		},
		orderBy: (table, { asc }) => [asc(table.position)],
	});

	const page = buildStatusPageSummary(pageRow, pageRow.clientImage);

	const mappedServices: StatusPageService[] = [];
	for (const link of serviceLinks) {
		if (!link.service) continue;
		mappedServices.push({
			id: link.service.id,
			name: link.service.name,
			description: link.description,
			imageUrl: link.service.imageUrl,
			position: link.position,
			createdAt: link.service.createdAt,
		});
	}
	const services = sortStatusPageServices(mappedServices);

	const serviceIds = services.map((service) => service.id);
	if (serviceIds.length === 0) {
		return { page, services, affections: [], updates: [] };
	}

	// Phase 2: load incident affections that touch those services.
	const serviceAffections = await db.query.incidentAffectionService.findMany({
		where: { serviceId: { in: serviceIds } },
		columns: { serviceId: true, impact: true },
		with: {
			affection: {
				columns: { id: true, incidentId: true, title: true, createdAt: true, updatedAt: true, resolvedAt: true },
			},
		},
	});

	const affectionMap = new Map<string, StatusPageAffection>();
	for (const row of serviceAffections) {
		const affection = row.affection;
		if (!affection) {
			continue;
		}
		const existing = affectionMap.get(affection.id);
		if (existing) {
			existing.services.push({ id: row.serviceId, impact: row.impact });
			continue;
		}
		affectionMap.set(affection.id, {
			id: affection.id,
			incidentId: affection.incidentId,
			title: affection.title,
			createdAt: affection.createdAt,
			updatedAt: affection.updatedAt,
			resolvedAt: affection.resolvedAt ?? null,
			services: [{ id: row.serviceId, impact: row.impact }],
		});
	}

	const affections = Array.from(affectionMap.values());
	const affectionIds = affections.map((affection) => affection.id);
	if (affectionIds.length === 0) {
		return { page, services, affections, updates: [] };
	}

	// Phase 3: load updates once for all matched affections.
	const updates = await db.query.incidentAffectionUpdate.findMany({
		where: { affectionId: { in: affectionIds } },
		columns: { id: true, affectionId: true, status: true, message: true, createdAt: true, createdBy: true },
		orderBy: (table, { asc }) => [asc(table.createdAt)],
	});

	return { page, services, affections, updates };
}

async function fetchPublicStatusPageByLookup(lookup: StatusPageLookup): Promise<StatusPagePublicData | null> {
	const pageRow = await findStatusPageContentWithClientRow(lookup);
	if (!pageRow) {
		return null;
	}

	return buildStatusPagePublicData(pageRow);
}

export async function fetchPublicStatusPageBySlug(slug: string): Promise<StatusPagePublicData | null> {
	return withCache(`status-page:slug:${slug}`, STANDARD_CACHE, () => fetchPublicStatusPageByLookup({ slug }));
}

export async function fetchPublicStatusPageByDomain(domain: string): Promise<StatusPagePublicData | null> {
	return withCache(`status-page:domain:${domain}`, STANDARD_CACHE, () => fetchPublicStatusPageByLookup({ domain }));
}

export type IncidentHistoryItem = {
	id: string;
	title: string;
	severity: "partial" | "major";
	createdAt: Date;
	resolvedAt: Date | null;
	lastUpdate: {
		status: "investigating" | "mitigating" | "resolved" | null;
		message: string | null;
		createdAt: Date;
	} | null;
};

export type IncidentHistoryData = {
	page: StatusPageSummary;
	incidents: IncidentHistoryItem[];
};

function getLatestAffectionUpdates<T extends { affectionId: string; createdAt: Date }>(updates: T[]): Map<string, T> {
	const latestByAffectionId = new Map<string, T>();
	for (const update of updates) {
		const current = latestByAffectionId.get(update.affectionId);
		if (!current || update.createdAt.getTime() > current.createdAt.getTime()) {
			latestByAffectionId.set(update.affectionId, update);
		}
	}
	return latestByAffectionId;
}

async function fetchIncidentHistoryByLookup(lookup: StatusPageLookup): Promise<IncidentHistoryData | null> {
	const pageRow = await findStatusPageContentWithClientRow(lookup);
	if (!pageRow) {
		return null;
	}

	const page = buildStatusPageSummary(pageRow, pageRow.clientImage);
	const serviceAffectionRows = await db
		.select({
			affectionId: incidentAffectionTable.id,
			title: incidentAffectionTable.title,
			createdAt: incidentAffectionTable.createdAt,
			resolvedAt: incidentAffectionTable.resolvedAt,
			impact: incidentAffectionServiceTable.impact,
		})
		.from(statusPageServiceTable)
		.innerJoin(incidentAffectionServiceTable, eq(incidentAffectionServiceTable.serviceId, statusPageServiceTable.serviceId))
		.innerJoin(incidentAffectionTable, eq(incidentAffectionTable.id, incidentAffectionServiceTable.affectionId))
		.where(eq(statusPageServiceTable.statusPageId, pageRow.id));

	if (serviceAffectionRows.length === 0) {
		return { page, incidents: [] };
	}

	const incidentMap = new Map<
		string,
		{
			id: string;
			title: string;
			severity: "partial" | "major";
			createdAt: Date;
			resolvedAt: Date | null;
		}
	>();
	for (const row of serviceAffectionRows) {
		const existing = incidentMap.get(row.affectionId);
		if (existing) {
			if (row.impact === "major") {
				existing.severity = "major";
			}
			continue;
		}

		incidentMap.set(row.affectionId, {
			id: row.affectionId,
			title: row.title,
			severity: row.impact === "major" ? "major" : "partial",
			createdAt: row.createdAt,
			resolvedAt: row.resolvedAt,
		});
	}

	const affectionIds = Array.from(incidentMap.keys());
	const updates = await db.query.incidentAffectionUpdate.findMany({
		where: { affectionId: { in: affectionIds } },
		columns: { affectionId: true, status: true, message: true, createdAt: true },
		orderBy: (table, { desc }) => [desc(table.createdAt)],
	});
	const latestUpdatesByAffectionId = getLatestAffectionUpdates(updates);

	const incidents: IncidentHistoryItem[] = Array.from(incidentMap.values())
		.map((incident) => {
			const lastUpdate = latestUpdatesByAffectionId.get(incident.id) ?? null;
			return {
				...incident,
				lastUpdate: lastUpdate
					? {
							status: lastUpdate.status,
							message: lastUpdate.message,
							createdAt: lastUpdate.createdAt,
						}
					: null,
			};
		})
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

	return { page, incidents };
}

export async function fetchIncidentHistoryByDomain(domain: string): Promise<IncidentHistoryData | null> {
	return withCache(`history:domain:${domain}`, STANDARD_CACHE, () => fetchIncidentHistoryByLookup({ domain }));
}

export async function fetchIncidentHistoryBySlug(slug: string): Promise<IncidentHistoryData | null> {
	return withCache(`history:slug:${slug}`, STANDARD_CACHE, () => fetchIncidentHistoryByLookup({ slug }));
}

export type IncidentDetailUpdate = {
	id: string;
	status: "investigating" | "mitigating" | "resolved" | null;
	message: string | null;
	createdAt: Date;
};

export type IncidentDetailData = {
	page: StatusPageSummary;
	incident: {
		id: string;
		title: string;
		severity: "partial" | "major";
		createdAt: Date;
		resolvedAt: Date | null;
		affectedServices: { id: string; name: string; impact: "partial" | "major" }[];
		updates: IncidentDetailUpdate[];
	};
};

async function fetchIncidentDetailDirect(pageRow: StatusPageContentWithClientRow, incidentId: string): Promise<IncidentDetailData | null> {
	const page = buildStatusPageSummary(pageRow, pageRow.clientImage);

	const serviceAffections = await db
		.select({
			affectionId: incidentAffectionTable.id,
			affectionTitle: incidentAffectionTable.title,
			affectionCreatedAt: incidentAffectionTable.createdAt,
			affectionResolvedAt: incidentAffectionTable.resolvedAt,
			serviceId: incidentAffectionServiceTable.serviceId,
			impact: incidentAffectionServiceTable.impact,
			serviceName: serviceTable.name,
		})
		.from(statusPageServiceTable)
		.innerJoin(incidentAffectionServiceTable, eq(incidentAffectionServiceTable.serviceId, statusPageServiceTable.serviceId))
		.innerJoin(incidentAffectionTable, eq(incidentAffectionTable.id, incidentAffectionServiceTable.affectionId))
		.innerJoin(serviceTable, eq(serviceTable.id, incidentAffectionServiceTable.serviceId))
		.where(and(eq(statusPageServiceTable.statusPageId, pageRow.id), eq(incidentAffectionServiceTable.affectionId, incidentId)));
	if (serviceAffections.length === 0) {
		return null;
	}

	const updateRows = await db.query.incidentAffectionUpdate.findMany({
		where: { affectionId: incidentId },
		columns: { id: true, status: true, message: true, createdAt: true },
		orderBy: (table, { desc }) => [desc(table.createdAt)],
	});

	const affection = serviceAffections[0];

	const severity: "partial" | "major" = serviceAffections.some((serviceAffection) => serviceAffection.impact === "major") ? "major" : "partial";
	const affectedServiceMap = new Map<string, { id: string; name: string; impact: "partial" | "major" }>();
	for (const serviceAffection of serviceAffections) {
		if (!affectedServiceMap.has(serviceAffection.serviceId)) {
			affectedServiceMap.set(serviceAffection.serviceId, {
				id: serviceAffection.serviceId,
				name: serviceAffection.serviceName ?? "Unknown Service",
				impact: serviceAffection.impact,
			});
		}
	}
	const affectedServices = Array.from(affectedServiceMap.values());

	const updates = updateRows.map((update) => ({
		id: update.id,
		status: update.status,
		message: update.message,
		createdAt: update.createdAt,
	}));

	return {
		page,
		incident: {
			id: affection.affectionId,
			title: affection.affectionTitle,
			severity,
			createdAt: affection.affectionCreatedAt,
			resolvedAt: affection.affectionResolvedAt,
			affectedServices,
			updates,
		},
	};
}

async function fetchIncidentDetailByLookup(lookup: StatusPageLookup, incidentId: string): Promise<IncidentDetailData | null> {
	const pageRow = await findStatusPageContentWithClientRow(lookup);
	if (!pageRow) {
		return null;
	}

	return fetchIncidentDetailDirect(pageRow, incidentId);
}

export async function fetchIncidentDetailByDomain(domain: string, incidentId: string): Promise<IncidentDetailData | null> {
	return withCache(`incident:domain:${domain}:${incidentId}`, STANDARD_CACHE, () => fetchIncidentDetailByLookup({ domain }, incidentId));
}

export async function fetchIncidentDetailBySlug(slug: string, incidentId: string): Promise<IncidentDetailData | null> {
	return withCache(`incident:slug:${slug}:${incidentId}`, STANDARD_CACHE, () => fetchIncidentDetailByLookup({ slug }, incidentId));
}

export type StatusSnapshotData = {
	page: Pick<StatusPageSummary, "id" | "name" | "slug">;
	overallStatus: "operational" | "issues";
	hasActiveIncidents: boolean;
	activeIncidentCount: number;
	activeMajorIncidentCount: number;
	activePartialIncidentCount: number;
	totalIncidentCount: number;
	lastUpdatedAt: Date;
	version: string;
};

function toTimestamp(date: Date | null | undefined): number | null {
	if (!date) {
		return null;
	}
	const value = new Date(date).getTime();
	return Number.isFinite(value) ? value : null;
}

export type LiveStatusInfo = {
	indicator: "none" | "minor" | "major";
	description: string;
	lastUpdatedAt: Date;
	version: string;
};

export function getStatusDescription(indicator: "none" | "minor" | "major"): string {
	if (indicator === "major") return "Major Service Outage";
	if (indicator === "minor") return "Some Systems Experiencing Issues";
	return "All Systems Operational";
}

export function computeLiveStatusInfo(data: StatusPagePublicData, fallbackTimestamp?: number): LiveStatusInfo {
	const activeAffections = data.affections.filter((a) => !a.resolvedAt);
	const hasMajorIssue = activeAffections.some((a) => a.services.some((s) => s.impact === "major"));
	const indicator: "none" | "minor" | "major" = hasMajorIssue ? "major" : activeAffections.length > 0 ? "minor" : "none";
	const description = getStatusDescription(indicator);

	const timestamps: number[] = [];
	const push = (date: Date | null | undefined) => {
		const value = toTimestamp(date);
		if (value !== null) timestamps.push(value);
	};

	push(data.page.createdAt);
	push(data.page.updatedAt);
	for (const affection of data.affections) {
		push(affection.createdAt);
		push(affection.updatedAt);
		push(affection.resolvedAt);
	}
	for (const update of data.updates) {
		push(update.createdAt);
	}

	const lastUpdatedAt = new Date(timestamps.length > 0 ? Math.max(...timestamps) : (fallbackTimestamp ?? Date.now()));
	const version = `${lastUpdatedAt.getTime()}-${activeAffections.length}-${data.updates.length}-${data.affections.length}`;

	return { indicator, description, lastUpdatedAt, version };
}

function buildStatusSnapshotFromPublicData(data: StatusPagePublicData): StatusSnapshotData {
	const activeAffections = data.affections.filter((affection) => !affection.resolvedAt);
	const activeCount = activeAffections.length;
	const activeMajorCount = activeAffections.filter((affection) => affection.services.some((service) => service.impact === "major")).length;
	const activePartialCount = activeCount - activeMajorCount;
	const liveStatus = computeLiveStatusInfo(data);

	return {
		page: { id: data.page.id, name: data.page.name, slug: data.page.slug },
		overallStatus: activeCount > 0 ? "issues" : "operational",
		hasActiveIncidents: activeCount > 0,
		activeIncidentCount: activeCount,
		activeMajorIncidentCount: activeMajorCount,
		activePartialIncidentCount: activePartialCount,
		totalIncidentCount: data.affections.length,
		lastUpdatedAt: liveStatus.lastUpdatedAt,
		version: liveStatus.version,
	};
}

async function fetchStatusSnapshotByLookup(lookup: StatusPageLookup): Promise<StatusSnapshotData | null> {
	const pageRow = await findStatusPageContentWithClientRow(lookup);
	if (!pageRow) {
		return null;
	}

	const publicData = await buildStatusPagePublicData(pageRow);
	return buildStatusSnapshotFromPublicData(publicData);
}

export async function fetchStatusSnapshotByDomain(domain: string): Promise<StatusSnapshotData | null> {
	return withCache(`snapshot:domain:${domain}`, SNAPSHOT_CACHE, () => fetchStatusSnapshotByLookup({ domain }));
}

export async function fetchStatusSnapshotBySlug(slug: string): Promise<StatusSnapshotData | null> {
	return withCache(`snapshot:slug:${slug}`, SNAPSHOT_CACHE, () => fetchStatusSnapshotByLookup({ slug }));
}
