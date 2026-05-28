import { relations } from "@fire/db/relations";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

function _makeDb(connectionString: string) {
	const pool = new Pool({
		connectionString,
		connectionTimeoutMillis: 15_000,
		query_timeout: 30_000,
		statement_timeout: 30_000,
	});
	return drizzle({ client: pool, relations });
}

type DrizzleDb = ReturnType<typeof _makeDb>;

let _db: DrizzleDb | null = null;

export function initDb(connectionString: string): void {
	if (_db) return;
	_db = _makeDb(connectionString);
}

export const db = new Proxy({} as DrizzleDb, {
	get(_, prop) {
		if (!_db) throw new Error("DB not initialized — call initDb() first");
		return (_db as any)[prop];
	},
});
