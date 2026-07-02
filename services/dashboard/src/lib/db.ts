import { relations } from "@fire/db/relations";
import * as schema from "@fire/db/schema";
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getCfEnv } from "./cf-context";

type DrizzleDb = NodePgDatabase<typeof schema, typeof relations>;

let _localDb: DrizzleDb | null = null;

function resolveDb(): DrizzleDb {
	const cfEnv = getCfEnv();
	if (cfEnv?.DB?.connectionString) {
		// Per-request Cloudflare Hyperdrive pool — short-lived, created per isolate
		return drizzle({
			schema,
			relations,
			client: new Pool({
				connectionString: cfEnv.DB.connectionString,
				max: 5,
				connectionTimeoutMillis: 15_000,
				query_timeout: 30_000,
				statement_timeout: 30_000,
			}),
		});
	}
	// Local dev singleton — reused across requests
	if (!_localDb) {
		_localDb = drizzle({
			schema,
			relations,
			client: new Pool({
				connectionString: process.env.DATABASE_URL!,
				connectionTimeoutMillis: 15_000,
				allowExitOnIdle: true,
				query_timeout: 30_000,
				statement_timeout: 30_000,
			}),
		});
	}
	return _localDb;
}

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
	get(_, prop: string | symbol) {
		return (resolveDb() as any)[prop];
	},
}) as unknown as DrizzleDb;
