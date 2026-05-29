import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";

const cacheControlMaxAge = 60 * 60 * 24 * 365;

function getExtensionFromContentType(contentType: string) {
	const parts = contentType.split("/");
	const ext = parts[1]?.split(";")[0]?.trim();
	return ext || "bin";
}

function getExtensionFromName(name: string) {
	const parts = name.split(".");
	const ext = parts.length > 1 ? parts[parts.length - 1] : "";
	return ext || "bin";
}

function getR2(): { bucket: typeof env.IMAGES; publicUrl: string } | null {
	if (env.IMAGES) {
		return {
			bucket: env.IMAGES,
			publicUrl: process.env.IMAGES_PUBLIC_URL ?? "",
		};
	}
	return null;
}

export async function uploadImageFromUrl(url: string, prefix: string): Promise<string | null> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return null;
	}

	if (parsedUrl.protocol !== "https:") {
		return null;
	}

	const response = await fetch(parsedUrl.toString(), { redirect: "follow" });
	if (!response.ok) {
		return null;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.startsWith("image/")) {
		return null;
	}

	const extension = getExtensionFromContentType(contentType);
	const pathname = `${prefix}/${nanoid()}.${extension}`;
	const body = await response.arrayBuffer();

	const r2 = getR2();
	if (!r2) {
		return null;
	}

	await r2.bucket.put(pathname, body, {
		httpMetadata: {
			cacheControl: `public, max-age=${cacheControlMaxAge}, immutable`,
			contentType,
		},
	});

	return `${r2.publicUrl}/${pathname}`;
}

export async function uploadImageFile(file: File, prefix: string): Promise<string | null> {
	const contentType = file.type || "application/octet-stream";
	if (!contentType.startsWith("image/")) {
		return null;
	}

	const extension = getExtensionFromName(file.name || "");
	const pathname = `${prefix}/${nanoid()}.${extension}`;

	const r2 = getR2();
	if (!r2) {
		return null;
	}

	await r2.bucket.put(pathname, file, {
		httpMetadata: {
			cacheControl: `public, max-age=${cacheControlMaxAge}, immutable`,
			contentType,
		},
	});

	return `${r2.publicUrl}/${pathname}`;
}
