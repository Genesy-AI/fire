type CacheEntry<T> = { value: T; staleAt: number; expiresAt: number };
const store = new Map<string, CacheEntry<unknown>>();

export const STANDARD_CACHE = { revalidate: 30, expire: 60 } as const;
export const SNAPSHOT_CACHE = { revalidate: 10, expire: 30 } as const;

export async function withCache<T>(
	key: string,
	{ revalidate, expire }: { revalidate: number; expire: number },
	fn: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const entry = store.get(key) as CacheEntry<T> | undefined;

	if (entry && entry.expiresAt > now) {
		if (entry.staleAt < now) {
			fn()
				.then((value) =>
					store.set(key, {
						value,
						staleAt: now + revalidate * 1000,
						expiresAt: now + expire * 1000,
					}),
				)
				.catch(() => {});
		}
		return entry.value;
	}

	const value = await fn();
	store.set(key, {
		value,
		staleAt: now + revalidate * 1000,
		expiresAt: now + expire * 1000,
	});
	return value;
}
