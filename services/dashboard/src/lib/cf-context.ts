import { AsyncLocalStorage } from "node:async_hooks";

export type CfEnv = {
	DB?: { connectionString: string };
	IMAGES?: {
		put: (key: string, value: ArrayBuffer | Blob | string, options?: { httpMetadata?: { cacheControl?: string; contentType?: string } }) => Promise<unknown>;
	};
	INCIDENTD?: { fetch: (req: Request) => Promise<Response> };
};

const als = new AsyncLocalStorage<CfEnv>();

export const getCfEnv = (): CfEnv | undefined => als.getStore();

export const runWithCfEnv = <T>(env: CfEnv, fn: () => T): T => als.run(env, fn);
