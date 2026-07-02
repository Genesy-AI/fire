import { relations } from "@fire/db/relations";
import * as schema from "@fire/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

type WithHyperdrive = { DB: { connectionString: string } };

function getConnectionString(): string {
	try {
		// @opennextjs/cloudflare exposes bindings via getRequestContext() in Next.js route handlers
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { getRequestContext } = require("@opennextjs/cloudflare");
		const { env } = getRequestContext() as { env: WithHyperdrive };
		if (env.DB?.connectionString) return env.DB.connectionString;
	} catch {
		// Not in a Cloudflare request context — local development
	}
	return process.env.DATABASE_URL!;
}

export function createDb() {
	const pool = new Pool({
		connectionString: getConnectionString(),
		connectionTimeoutMillis: 15_000,
		query_timeout: 30_000,
		statement_timeout: 30_000,
	});
	return drizzle({ schema, relations, client: pool });
}

export const db = createDb();
