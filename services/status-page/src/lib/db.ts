import { AsyncLocalStorage } from "node:async_hooks";
import { relations } from "@fire/db/relations";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

function makeDb(connectionString: string) {
	const client = new Client({
		connectionString,
		connectionTimeoutMillis: 15_000,
		query_timeout: 30_000,
		statement_timeout: 30_000,
	});
	return { client, db: drizzle({ client, relations }) };
}

type RequestDb = ReturnType<typeof makeDb>;
type DrizzleDb = RequestDb["db"];

const requestDbStorage = new AsyncLocalStorage<DrizzleDb>();

export async function withRequestDb<T>(connectionString: string, fn: () => Promise<T>): Promise<T> {
	const requestDb = makeDb(connectionString);
	await requestDb.client.connect();
	try {
		return await requestDbStorage.run(requestDb.db, fn);
	} finally {
		await requestDb.client.end();
	}
}

export const db = new Proxy({} as DrizzleDb, {
	get(_, prop) {
		const requestDb = requestDbStorage.getStore();
		if (!requestDb) throw new Error("DB not initialized — call withRequestDb() first");
		return Reflect.get(requestDb, prop);
	},
});
