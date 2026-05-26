import type { Context, Next } from "hono";
import type { AuthContext } from "../../../handler";

export async function verifyDashboardRequestMiddleware(c: Context<AuthContext>, next: Next) {
	const clientId = c.req.header("X-Client-Id");
	const userId = c.req.header("X-User-Id");

	if (!clientId || !userId) {
		return c.json({ error: "Unauthorized: Missing auth headers" }, 401);
	}

	c.set("auth", { clientId, userId });
	await next();
}
