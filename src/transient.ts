/** Errors that usually clear on their own: timeouts, network trouble, overloaded or rate-limited services. */
export function isTransient(error: string): boolean {
	return /timed out|timeout|ETIMEDOUT|could not resolve|connection (refused|reset)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|\b(408|429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|temporarily|unavailable/i.test(error);
}
