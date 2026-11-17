/** Runs `fn` with console.error muted, for paths that log on purpose. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
	const original = console.error;
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.error = original;
	}
}
