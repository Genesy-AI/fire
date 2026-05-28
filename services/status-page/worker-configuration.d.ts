interface Hyperdrive {
	connectionString: string;
}

interface Env {
	DB: Hyperdrive;
	STATUS_PAGE_DOMAIN?: string;
	APP_URL?: string;
	INTERCOM_CLIENT_SECRET?: string;
}
