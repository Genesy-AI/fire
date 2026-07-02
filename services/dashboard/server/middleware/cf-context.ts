import { defineMiddleware } from "h3";
import { runWithCfEnv } from "~/lib/cf-context";

export default defineMiddleware((event, next) => {
	const cfEnv = (event.context as any).cloudflare?.env;
	if (cfEnv) {
		return runWithCfEnv(cfEnv, next);
	}
	return next();
});
