import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliError, dataDir, type Io, readJson, writePrivate } from "./util.ts";

const SCOPE = "https://www.googleapis.com/auth/";

/** What `google auth start` asks for. gmail.modify covers read, labels, drafts and send; no permanent delete. */
export const FULL_SCOPES = [`${SCOPE}gmail.modify`, `${SCOPE}calendar.events`, `${SCOPE}calendar.readonly`];
export const READ_ONLY_SCOPES = [`${SCOPE}gmail.readonly`, `${SCOPE}calendar.readonly`];

export type Capability = "gmail.read" | "gmail.modify" | "gmail.compose" | "gmail.send" | "calendar.read" | "calendar.write";

/** Scopes (without the URL prefix) that grant each capability. */
const GRANTS: Record<Capability, string[]> = {
	"gmail.read": ["gmail.readonly", "gmail.modify", "https://mail.google.com/"],
	"gmail.modify": ["gmail.modify", "https://mail.google.com/"],
	"gmail.compose": ["gmail.compose", "gmail.modify", "https://mail.google.com/"],
	"gmail.send": ["gmail.send", "gmail.compose", "gmail.modify", "https://mail.google.com/"],
	"calendar.read": ["calendar.readonly", "calendar", "calendar.events", "calendar.events.readonly"],
	"calendar.write": ["calendar", "calendar.events"],
};

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const DEFAULT_REDIRECT = "http://localhost";
const EARLY_REFRESH_MS = 120_000;

/** The google-auth "authorized user" JSON format, which Python and Node Google libraries read and write. */
export interface AuthorizedUser {
	type?: string;
	client_id?: string;
	client_secret?: string;
	refresh_token?: string;
	token?: string;
	access_token?: string;
	expiry?: string;
	token_uri?: string;
	scopes?: string[] | string;
	scope?: string;
	account?: string;
	universe_domain?: string;
}

interface ClientFile {
	installed?: ClientFields;
	web?: ClientFields;
	client_id?: string;
	client_secret?: string;
}

interface ClientFields {
	client_id?: string;
	client_secret?: string;
	auth_uri?: string;
	token_uri?: string;
	redirect_uris?: string[];
}

export interface Client {
	clientId: string;
	clientSecret: string;
	authUri: string;
	tokenUri: string;
	redirectUri: string;
}

interface Pending {
	state: string;
	verifier: string;
	redirectUri: string;
	scopes: string[];
	createdAt: number;
}

interface Cache {
	fingerprint: string;
	accessToken: string;
	expiresAt: number;
	scope?: string;
}

/** Accepts a Google client-secret JSON (installed or web) or an authorized-user JSON. */
export function parseClient(json: unknown): Client | undefined {
	const file = (json ?? {}) as ClientFile;
	const fields: ClientFields = file.installed ?? file.web ?? file;
	if (!fields.client_id || !fields.client_secret) return undefined;
	const redirect = fields.redirect_uris?.find((u) => /^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) ?? fields.redirect_uris?.[0];
	return {
		clientId: fields.client_id,
		clientSecret: fields.client_secret,
		authUri: fields.auth_uri ?? DEFAULT_AUTH_URI,
		tokenUri: fields.token_uri ?? DEFAULT_TOKEN_URI,
		redirectUri: file.web ? (redirect ?? DEFAULT_REDIRECT) : DEFAULT_REDIRECT,
	};
}

export function scopeList(value: string[] | string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = Array.isArray(value) ? value : value.split(/\s+/);
	return list.filter(Boolean);
}

export function hasCapability(granted: string[] | undefined, capability: Capability): boolean {
	if (!granted) return true; // unknown: let Google decide
	return GRANTS[capability].some((s) => granted.includes(s.startsWith("https://") ? s : `${SCOPE}${s}`));
}

const fingerprint = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);

function parseExpiry(expiry: string | undefined): number {
	if (!expiry) return 0;
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(expiry) ? expiry : `${expiry}Z`);
	return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Credentials live in `$NANO_DATA_DIR/google/` (client_secret.json, token.json, both 0600).
 * `GOOGLE_TOKEN_FILE` / `GOOGLE_CLIENT_SECRET_FILE` point at files owned by someone else instead;
 * those are only ever read. Refreshed access tokens always go to our own cache.json.
 */
export class Auth {
	private readonly io: Io;
	/** Parsed `token.json` (or the shared token file). Read once per process until we change it. */
	private tokenRaw: AuthorizedUser | undefined;
	private tokenLoaded = false;
	/** Shared file exists but is not JSON. Cached with the token so later calls do not stat again. */
	private tokenUnreadable = false;
	/** Parsed `cache.json`. Read once per process until we change it. */
	private cacheRaw: Cache | undefined;
	private cacheLoaded = false;
	/** Access token already resolved for this process. */
	private memory: { accessToken: string; expiresAt: number } | undefined;
	/** One refresh in flight, shared by every concurrent caller. */
	private refreshing: Promise<string> | undefined;

	constructor(io: Io) {
		this.io = io;
	}

	get dir(): string {
		return join(dataDir(this.io.env), "google");
	}

	/** True when the token belongs to another program and must not be written. */
	get shared(): boolean {
		return Boolean(this.io.env.GOOGLE_TOKEN_FILE);
	}

	get tokenPath(): string {
		return this.io.env.GOOGLE_TOKEN_FILE || join(this.dir, "token.json");
	}

	get clientPath(): string {
		return this.io.env.GOOGLE_CLIENT_SECRET_FILE || join(this.dir, "client_secret.json");
	}

	private get cachePath(): string {
		return join(this.dir, "cache.json");
	}

	private get pendingPath(): string {
		return join(this.dir, "pending.json");
	}

	/** The token file, parsed once until `rememberToken` (this process wrote it, or logout). */
	private loadTokenFile(): AuthorizedUser | undefined {
		if (!this.tokenLoaded) {
			this.tokenRaw = readJson<AuthorizedUser>(this.tokenPath);
			this.tokenUnreadable = this.tokenRaw === undefined && this.shared && existsSync(this.tokenPath);
			this.tokenLoaded = true;
		}
		return this.tokenRaw;
	}

	private rememberToken(raw: AuthorizedUser | undefined): void {
		this.tokenRaw = raw;
		this.tokenLoaded = true;
		this.tokenUnreadable = false;
	}

	private loadCache(): Cache | undefined {
		if (!this.cacheLoaded) {
			this.cacheRaw = readJson<Cache>(this.cachePath);
			this.cacheLoaded = true;
		}
		return this.cacheRaw;
	}

	private rememberCache(cache: Cache | undefined): void {
		this.cacheRaw = cache;
		this.cacheLoaded = true;
		this.memory = undefined;
	}

	token(): AuthorizedUser | undefined {
		const token = this.loadTokenFile();
		if (this.tokenUnreadable) {
			throw new CliError(`GOOGLE_TOKEN_FILE (${this.tokenPath}) is not readable JSON. Check the path and file permissions.`);
		}
		return token?.refresh_token ? token : undefined;
	}

	client(): Client | undefined {
		const fromFile = parseClient(readJson(this.clientPath));
		if (fromFile) return fromFile;
		const token = this.loadTokenFile();
		const fromToken = parseClient(token);
		return fromToken ? { ...fromToken, tokenUri: token?.token_uri ?? DEFAULT_TOKEN_URI } : undefined;
	}

	grantedScopes(): string[] | undefined {
		const token = this.token();
		return scopeList(token?.scopes) ?? scopeList(token?.scope) ?? scopeList(this.loadCache()?.scope);
	}

	require(capability: Capability): void {
		if (!this.token()) throw this.notConnected();
		if (hasCapability(this.grantedScopes(), capability)) return;
		throw new CliError(this.missingPermission(capability));
	}

	missingPermission(what: string): string {
		return this.shared
			? `The shared Google token (GOOGLE_TOKEN_FILE) does not grant ${what}. It only has: ${(this.grantedScopes() ?? []).map((s) => s.replace(SCOPE, "")).join(", ") || "unknown scopes"}. Re-consent with the needed scopes in the program that owns that file, or connect Nano with its own token.`
			: `The Google connection does not grant ${what}. Reconnect with full access: google auth start`;
	}

	notConnected(): CliError {
		return this.shared
			? new CliError(`GOOGLE_TOKEN_FILE (${this.tokenPath}) has no refresh_token. It must be an authorized-user token JSON.`)
			: new CliError("Google is not connected yet. Follow the connection steps in the gmail skill (google auth start).");
	}

	/** Save the owner's OAuth client from a downloaded JSON or from a pasted id and secret. */
	saveClient(json: unknown): Client {
		if (this.io.env.GOOGLE_CLIENT_SECRET_FILE) {
			throw new CliError("GOOGLE_CLIENT_SECRET_FILE is set, so Nano uses that client file. Unset it to store a client here.");
		}
		const client = parseClient(json);
		if (!client) throw new CliError("That is not a Google OAuth client. It needs a client_id and client_secret (Desktop app type).", 2);
		const file = {
			installed: {
				client_id: client.clientId,
				client_secret: client.clientSecret,
				auth_uri: client.authUri,
				token_uri: client.tokenUri,
				redirect_uris: [client.redirectUri],
			},
		};
		writePrivate(join(this.dir, "client_secret.json"), `${JSON.stringify(file, null, 2)}\n`);
		return client;
	}

	/** Begin the consent flow: returns the URL the owner opens on their phone. */
	start(scopes: string[]): string {
		if (this.shared) {
			throw new CliError("GOOGLE_TOKEN_FILE is set, so Nano uses that token read-only. Unset it to connect Nano with its own token.");
		}
		const client = this.client();
		if (!client) {
			throw new CliError("No Google OAuth client yet. Save one first: google auth client <client_secret.json> (or --id <id> --secret <secret>).");
		}
		const verifier = randomBytes(48).toString("base64url");
		const state = randomBytes(16).toString("hex");
		const pending: Pending = { state, verifier, redirectUri: client.redirectUri, scopes, createdAt: this.io.now() };
		writePrivate(this.pendingPath, JSON.stringify(pending));
		const url = new URL(client.authUri);
		url.search = new URLSearchParams({
			client_id: client.clientId,
			redirect_uri: client.redirectUri,
			response_type: "code",
			scope: scopes.join(" "),
			access_type: "offline",
			prompt: "consent",
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			state,
		}).toString();
		return url.toString();
	}

	/** Finish the consent flow with the pasted redirect URL (or bare code). Returns the saved token. */
	async finish(pasted: string): Promise<AuthorizedUser> {
		if (this.shared) throw new CliError("GOOGLE_TOKEN_FILE is set, so Nano uses that token read-only. Unset it to connect Nano with its own token.");
		const pending = readJson<Pending>(this.pendingPath);
		if (!pending) throw new CliError("There is no sign-in in progress. Run google auth start first.");
		const client = this.client();
		if (!client) throw new CliError("The OAuth client is missing. Run google auth client again, then google auth start.");

		const { code, state, error } = parseRedirect(pasted);
		if (error) throw new CliError(`Google did not grant access (${error}). Run google auth start and press Allow.`);
		if (!code) throw new CliError("No authorization code found. Paste the whole address from the page that failed to load.", 2);
		if (state && state !== pending.state) {
			throw new CliError("That link is from an older sign-in attempt. Run google auth start again and use the new link.");
		}

		const response = await this.tokenRequest(client.tokenUri, {
			grant_type: "authorization_code",
			code,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: pending.redirectUri,
			code_verifier: pending.verifier,
		});
		if (!response.refresh_token) {
			throw new CliError("Google returned no refresh token. Remove Nano's access at myaccount.google.com/permissions, then run google auth start again.");
		}
		const now = this.io.now();
		const token: AuthorizedUser = {
			type: "authorized_user",
			client_id: client.clientId,
			client_secret: client.clientSecret,
			refresh_token: response.refresh_token,
			token: response.access_token,
			expiry: new Date(now + (response.expires_in ?? 3600) * 1000).toISOString(),
			token_uri: client.tokenUri,
			scopes: scopeList(response.scope) ?? pending.scopes,
			universe_domain: "googleapis.com",
			account: "",
		};
		writePrivate(this.tokenPath, `${JSON.stringify(token, null, 2)}\n`);
		rmSync(this.pendingPath, { force: true });
		rmSync(this.cachePath, { force: true });
		this.rememberToken(token);
		this.rememberCache(undefined);
		return token;
	}

	setAccount(account: string): void {
		if (this.shared) return;
		const token = this.token();
		if (!token) return;
		const updated = { ...token, account };
		writePrivate(this.tokenPath, `${JSON.stringify(updated, null, 2)}\n`);
		this.rememberToken(updated);
	}

	logout(): void {
		if (this.shared) throw new CliError("GOOGLE_TOKEN_FILE is set; Nano never deletes a shared token. Unset the variable instead.");
		for (const name of ["token.json", "cache.json", "pending.json"]) rmSync(join(this.dir, name), { force: true });
		this.rememberToken(undefined);
		this.rememberCache(undefined);
	}

	/**
	 * A valid access token. The token file and `cache.json` are read once per process, then kept
	 * in memory until this process changes them. `force` skips every cache and uses the refresh
	 * token (keepalive). Concurrent callers share one in-flight refresh.
	 */
	async accessToken(force = false): Promise<string> {
		if (!force) {
			const hit = this.cachedAccess();
			if (hit) return hit;
		}
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = undefined;
			});
		}
		return this.refreshing;
	}

	/** Access token from memory, the token file, or `cache.json`, when it is still fresh. */
	private cachedAccess(): string | undefined {
		const now = this.io.now();
		if (this.memory && this.memory.expiresAt > now + EARLY_REFRESH_MS) return this.memory.accessToken;
		const token = this.token();
		if (!token?.refresh_token) return undefined;
		const own = token.token ?? token.access_token;
		const ownExp = parseExpiry(token.expiry);
		if (own && ownExp > now + EARLY_REFRESH_MS) {
			this.memory = { accessToken: own, expiresAt: ownExp };
			return own;
		}
		const cache = this.loadCache();
		if (cache?.fingerprint === fingerprint(token.refresh_token) && cache.expiresAt > now + EARLY_REFRESH_MS) {
			this.memory = { accessToken: cache.accessToken, expiresAt: cache.expiresAt };
			return cache.accessToken;
		}
		return undefined;
	}

	private async refresh(): Promise<string> {
		const token = this.token();
		if (!token?.refresh_token) throw this.notConnected();
		const now = this.io.now();
		const fp = fingerprint(token.refresh_token);
		const client = this.client();
		if (!client) throw new CliError("The token has no client_id/client_secret and no client file is configured (GOOGLE_CLIENT_SECRET_FILE).");
		let response: TokenResponse;
		try {
			response = await this.tokenRequest(token.token_uri ?? client.tokenUri, {
				grant_type: "refresh_token",
				refresh_token: token.refresh_token,
				client_id: token.client_id ?? client.clientId,
				client_secret: token.client_secret ?? client.clientSecret,
			});
		} catch (error) {
			if (error instanceof CliError && /invalid_grant/.test(error.message)) {
				throw new CliError(
					this.shared
						? "The shared Google token was revoked or expired (invalid_grant). Reconnect in the program that owns it."
						: "The Google connection expired or was revoked (invalid_grant). Reconnect: google auth start",
				);
			}
			throw error;
		}
		const cache: Cache = {
			fingerprint: fp,
			accessToken: response.access_token,
			expiresAt: now + (response.expires_in ?? 3600) * 1000,
			scope: response.scope,
		};
		writePrivate(this.cachePath, JSON.stringify(cache));
		this.cacheRaw = cache;
		this.cacheLoaded = true;
		this.memory = { accessToken: response.access_token, expiresAt: cache.expiresAt };
		if (response.refresh_token && response.refresh_token !== token.refresh_token && !this.shared) {
			const updated = { ...token, refresh_token: response.refresh_token };
			writePrivate(this.tokenPath, `${JSON.stringify(updated, null, 2)}\n`);
			this.rememberToken(updated);
		}
		return response.access_token;
	}

	private async tokenRequest(uri: string, form: Record<string, string>): Promise<TokenResponse> {
		const response = await this.io.fetch(uri, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
		if (!response.ok || !body.access_token) {
			throw new CliError(`Google token request failed: ${body.error ?? `HTTP ${response.status}`}${body.error_description ? ` (${body.error_description})` : ""}`);
		}
		return body;
	}
}

interface TokenResponse {
	access_token: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
}

/** Pull code/state/error out of whatever the owner pasted: a full URL, a URL without scheme, or the bare code. */
export function parseRedirect(pasted: string): { code?: string; state?: string; error?: string } {
	const text = pasted.trim().replace(/^["'<]+|["'>]+$/g, "");
	if (/[?&](code|error)=/.test(text)) {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			url = new URL(`http://${text.replace(/^\/+/, "")}`);
		}
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			error: url.searchParams.get("error") ?? undefined,
		};
	}
	if (!text || /\s/.test(text)) return {};
	return { code: text.includes("%") ? decodeURIComponent(text) : text };
}
