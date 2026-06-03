import { env } from "cloudflare:workers";
import { createHmac, timingSafeEqual } from "node:crypto";

export function mustGetEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing env var: ${name}`);
	return v;
}

export async function sha256(str: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(str);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function incidentdFetch(path: string, authContext: { clientId: string; userId: string }, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {
		...((init?.headers as Record<string, string>) ?? {}),
		"X-Client-Id": authContext.clientId,
		"X-User-Id": authContext.userId,
	};

	if (env.INCIDENTD) {
		const incidentdPath = path === "/" ? "/dashboard" : `/dashboard${path}`;
		return env.INCIDENTD.fetch(new Request(`https://incidentd${incidentdPath}`, { ...init, headers }));
	}

	return fetch(`${process.env.INCIDENTS_URL}${path}`, { ...init, headers });
}

export function sign(obj: Record<string, unknown>) {
	const secret = process.env.BETTER_AUTH_SECRET!;
	const payload = JSON.stringify({ ...obj, ts: Date.now() });
	const encoded = Buffer.from(payload).toString("base64url");
	const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
	return `${encoded}.${signature}`;
}

export function extractSigned<T extends Record<string, unknown>>(signed: string): T | null {
	const secret = process.env.BETTER_AUTH_SECRET!;
	const [encoded, signature] = signed.split(".");

	if (!encoded || !signature) {
		return null;
	}

	const expectedSignature = createHmac("sha256", secret).update(encoded).digest("base64url");

	try {
		const sigBuffer = Buffer.from(signature, "base64url");
		const expectedBuffer = Buffer.from(expectedSignature, "base64url");

		if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
			return null;
		}
	} catch {
		return null;
	}

	try {
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!payload.clientId || !payload.userId) {
			return null;
		}

		return payload as T;
	} catch {
		return null;
	}
}
