import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./runtime-shim";
import {
	CALENDAR_EVENTS_SCOPE,
	CALENDAR_LIST_SCOPE,
	GMAIL_SCOPE,
	SETTINGS_SCOPE,
} from "../src/features";
import { putAccount } from "../src/registry";

const { GmailMCP } = await import("../src/index");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
type Route = (url: string, init: RequestInit) => unknown;

const realFetch = globalThis.fetch;
const SECRET = "test-cookie-secret";
const ALL_SCOPES = [GMAIL_SCOPE, SETTINGS_SCOPE, CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE].join(
	" ",
);

function parseBody(body: BodyInit | null | undefined): unknown {
	if (!body) return undefined;
	const text = String(body);
	try {
		return JSON.parse(text);
	} catch {
		return Object.fromEntries(new URLSearchParams(text));
	}
}

/** Every request the agent made during a test. */
let requests: { url: string; method: string; body: unknown }[] = [];

function serve(routes: [RegExp, Route][]) {
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		requests.push({ url, method: init.method ?? "GET", body: parseBody(init.body) });
		for (const [pattern, route] of routes) {
			if (pattern.test(url)) {
				const value = route(url, init);
				if (value instanceof Response) return value;
				return new Response(JSON.stringify(value), { status: 200 });
			}
		}
		return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
	}) as unknown as typeof fetch;
}

function memoryKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		list: async ({ prefix }: { prefix?: string; limit?: number }) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).map((name) => ({ name })),
			list_complete: true,
		}),
	};
}

function makeAgent({
	email = "me@example.com",
	scopes = ALL_SCOPES,
	kv = memoryKv(),
	vars = {} as Record<string, string>,
} = {}) {
	const handlers = new Map<string, Handler>();
	const toolMetadata = new Map<string, Record<string, unknown>>();
	const storage = new Map<string, unknown>();
	const agent = Object.create(GmailMCP.prototype) as Record<string, unknown>;
	agent.server = {
		tool: (name: string, _d: string, _s: unknown, cb: Handler) => handlers.set(name, cb),
		registerTool: (name: string, config: Record<string, unknown>, cb: Handler) => {
			handlers.set(name, cb);
			toolMetadata.set(name, config);
		},
	};
	agent.props = {
		email,
		name: "Tester",
		accessToken: "access-token",
		refreshToken: "refresh-token",
		expiresAt: Date.now() + 3_600_000,
		scopes,
	};
	agent.ctx = {
		id: { name: "streamable-http:session-1" },
		storage: {
			get: async (key: string) => storage.get(key),
			put: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
			list: async (options?: { prefix?: string }) =>
				new Map([...storage].filter(([key]) => key.startsWith(options?.prefix ?? ""))),
			delete: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
			},
		},
	};
	agent.env = {
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		COOKIE_ENCRYPTION_KEY: SECRET,
		OAUTH_KV: kv,
		...vars,
	};
	return { agent, handlers, storage, kv, toolMetadata };
}

async function boot(options: Parameters<typeof makeAgent>[0] = {}) {
	const made = makeAgent(options);
	await (made.agent as { init: () => Promise<void> }).init();
	return made;
}

function tool(handlers: Map<string, Handler>, name: string): Handler {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`no handler registered for ${name}`);
	return handler;
}

function result(reply: { content: { text: string }[] }): Record<string, unknown> {
	return JSON.parse(reply.content[0]?.text ?? "{}");
}

function resultArray(reply: { content: { text: string }[] }): Record<string, unknown>[] {
	return JSON.parse(reply.content[0]?.text ?? "[]");
}

const metadataMessage = (headers: Record<string, string>) => ({
	id: "m-1",
	threadId: "t-1",
	payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
});

beforeEach(() => {
	requests = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("ChatGPT conversation attachments", () => {
	test("send_message advertises fileParams and automatically attaches provided files", async () => {
		const { handlers, toolMetadata } = await boot();
		const config = toolMetadata.get("send_message");
		expect((config?._meta as Record<string, unknown>)?.["openai/fileParams"]).toEqual(["files"]);
		serve([
			[
				/files\.oaiusercontent\.com\/test-file/,
				() => new Response(new Uint8Array([80, 68, 70]), {
					status: 200,
					headers: { "content-type": "application/pdf", "content-length": "3" },
				}),
			],
			[/messages\/send$/, () => ({ id: "sent-file", threadId: "thread-file" })],
		]);
		const out = result(await tool(handlers, "send_message")({
			to: "recipient@example.com",
			subject: "Documents",
			body: "Please find the documents attached.",
			attachments: [],
			inlineImages: [],
			files: [{
				download_url: "https://files.oaiusercontent.com/test-file",
				file_id: "file-123",
				mime_type: "application/pdf",
				file_name: "document.pdf",
			}],
		}));
		expect(out.id).toBe("sent-file");
		const sent = requests.find((request) => request.url.includes("/messages/send"));
		const raw = (sent?.body as { raw: string } | undefined)?.raw ?? "";
		const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
		expect(decoded).toContain("document.pdf");
		expect(decoded).toContain("application/pdf");
		expect(decoded).toContain("UERG");
	});

	test("refuses untrusted attachment download hosts before fetching", async () => {
		const { handlers } = await boot();
		serve([]);
		await expect(tool(handlers, "send_message")({
			to: "recipient@example.com",
			subject: "Documents",
			body: "Attached.",
			attachments: [],
			inlineImages: [],
			files: [{
				download_url: "https://attacker.example/file",
				file_id: "file-123",
				file_name: "document.pdf",
			}],
		})).rejects.toThrow("trusted files.oaiusercontent.com");
		expect(requests).toHaveLength(0);
	});
});

describe("read state", () => {
	test("mark_read strips UNREAD in one batch", async () => {
		const { handlers } = await boot();
		serve([[/batchModify/, () => new Response(null, { status: 204 })]]);
		const out = result(await tool(handlers, "mark_read")({ messageIds: ["a", "b"] }));
		expect(out.markedRead).toBe(2);
		expect(requests[0]?.body).toEqual({ ids: ["a", "b"], removeLabelIds: ["UNREAD"] });
	});

	test("mark_unread adds UNREAD back", async () => {
		const { handlers } = await boot();
		serve([[/batchModify/, () => new Response(null, { status: 204 })]]);
		result(await tool(handlers, "mark_unread")({ messageIds: ["a"] }));
		expect(requests[0]?.body).toEqual({ ids: ["a"], addLabelIds: ["UNREAD"] });
	});
});

describe("filters", () => {
	test("create_filter posts the criteria and action it was given", async () => {
		const { handlers } = await boot();
		serve([
			[
				/settings\/filters$/,
				() => ({
					id: "f-1",
					criteria: { from: "noise@example.com" },
					action: { removeLabelIds: ["INBOX"] },
				}),
			],
		]);
		const out = result(
			await tool(
				handlers,
				"create_filter",
			)({
				criteria: { from: "noise@example.com" },
				action: { removeLabelIds: ["INBOX"] },
			}),
		);
		expect(out.id).toBe("f-1");
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.body).toEqual({
			criteria: { from: "noise@example.com" },
			action: { removeLabelIds: ["INBOX"] },
		});
	});

	test("a filter with nothing to match or nothing to do is refused", async () => {
		const { handlers } = await boot();
		serve([]);
		expect(
			tool(handlers, "create_filter")({ criteria: {}, action: { addLabelIds: ["X"] } }),
		).rejects.toThrow("at least one criteria");
		expect(
			tool(handlers, "create_filter")({ criteria: { from: "a@b.c" }, action: {} }),
		).rejects.toThrow("at least one action");
	});

	// The scope was requested at sign-in; a grant that ticked it off must be
	// told to reconnect rather than shown a bare Google 403.
	test("a grant without the settings scope is told to reconnect", async () => {
		const { handlers } = await boot({ scopes: GMAIL_SCOPE });
		serve([]);
		expect(tool(handlers, "list_filters")({})).rejects.toThrow("reconnect");
	});

	test("the filter tools stay unregistered when the feature is off", async () => {
		const { handlers } = await boot({ vars: { ENABLE_FILTERS: "false" } });
		expect(handlers.has("create_filter")).toBe(false);
		expect(handlers.has("list_filters")).toBe(false);
		expect(handlers.has("delete_filter")).toBe(false);
	});
});

describe("unsubscribe", () => {
	const listMessage = metadataMessage({
		From: "News <news@list.example>",
		Subject: "Weekly",
		"List-Unsubscribe": "<mailto:leave@list.example>, <https://list.example/u?id=7>",
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});

	test("get_unsubscribe_info reads the channels without acting", async () => {
		const { handlers } = await boot();
		serve([[/messages\/m-1\?format=metadata/, () => listMessage]]);
		const out = result(await tool(handlers, "get_unsubscribe_info")({ messageId: "m-1" }));
		expect(out.oneClick).toBe(true);
		expect(out.httpsUrls).toEqual(["https://list.example/u?id=7"]);
		expect((out.mailto as { to: string }).to).toBe("leave@list.example");
		// Reading must not have posted anywhere.
		expect(requests.every((r) => r.method === "GET")).toBe(true);
	});

	test("one-click POSTs the RFC 8058 body to the https channel", async () => {
		const { handlers } = await boot();
		serve([
			[/messages\/m-1\?format=metadata/, () => listMessage],
			[/^https:\/\/list\.example\/u\?id=7$/, () => new Response("", { status: 200 })],
		]);
		const out = result(await tool(handlers, "unsubscribe")({ messageId: "m-1", method: "auto" }));
		expect(out.unsubscribed).toBe(true);
		expect(out.method).toBe("one-click-http");
		const post = requests.find((r) => r.url === "https://list.example/u?id=7");
		expect(post?.method).toBe("POST");
		expect(post?.body).toEqual({ "List-Unsubscribe": "One-Click" });
	});

	test("without one-click the mailto channel carries the request", async () => {
		const { handlers } = await boot();
		serve([
			[
				/messages\/m-1\?format=metadata/,
				() =>
					metadataMessage({
						From: "News <news@list.example>",
						"List-Unsubscribe": "<mailto:leave@list.example?subject=unsub%20me>",
					}),
			],
			[/messages\/send/, () => ({ id: "sent-1" })],
		]);
		const out = result(await tool(handlers, "unsubscribe")({ messageId: "m-1", method: "auto" }));
		expect(out.method).toBe("mailto");
		expect(out.to).toBe("leave@list.example");
		const sent = requests.find((r) => r.url.includes("/send"));
		const raw = (sent?.body as { raw: string } | undefined)?.raw ?? "";
		const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
		expect(decoded).toContain("To: leave@list.example");
		expect(decoded).toContain("Subject: unsub me");
	});

	// A page-only sender means a human in a browser; visiting it from here
	// would either fail or click through who-knows-what.
	test("a sender offering only a web page gets its URL returned", async () => {
		const { handlers } = await boot();
		serve([
			[
				/messages\/m-1\?format=metadata/,
				() => metadataMessage({ "List-Unsubscribe": "<https://list.example/manual>" }),
			],
		]);
		const out = result(await tool(handlers, "unsubscribe")({ messageId: "m-1", method: "auto" }));
		expect(out.method).toBe("manual");
		expect(out.unsubscribed).toBe(false);
		expect(out.url).toBe("https://list.example/manual");
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
	});

	test("a message with no channel at all says so", async () => {
		const { handlers } = await boot();
		serve([[/messages\/m-1\?format=metadata/, () => metadataMessage({ From: "x@y.example" })]]);
		expect(tool(handlers, "unsubscribe")({ messageId: "m-1", method: "auto" })).rejects.toThrow(
			"no unsubscribe channel",
		);
	});
});

describe("calendar", () => {
	test("create_event builds the event and says who gets emailed", async () => {
		const { handlers } = await boot();
		serve([
			[
				/calendar\/v3\/calendars\/primary\/events\?sendUpdates=all/,
				(_url, init) => ({ id: "e-1", ...(parseBody(init.body) as object) }),
			],
		]);
		const out = result(
			await tool(
				handlers,
				"create_event",
			)({
				calendarId: "primary",
				summary: "Standup",
				start: { dateTime: "2026-08-12T10:00:00", timeZone: "Europe/Sofia" },
				end: { dateTime: "2026-08-12T10:30:00", timeZone: "Europe/Sofia" },
				attendees: ["a@example.com"],
				sendUpdates: "all",
			}),
		);
		expect(out.id).toBe("e-1");
		expect(requests[0]?.body).toEqual({
			summary: "Standup",
			start: { dateTime: "2026-08-12T10:00:00", timeZone: "Europe/Sofia" },
			end: { dateTime: "2026-08-12T10:30:00", timeZone: "Europe/Sofia" },
			attendees: [{ email: "a@example.com" }],
		});
	});

	// Calendar refuses zoneless local times server-side with a message about
	// formats; the argument check names the argument instead.
	test("a zoneless dateTime without a timeZone is refused before the API", async () => {
		const { handlers } = await boot();
		serve([]);
		expect(
			tool(
				handlers,
				"create_event",
			)({
				calendarId: "primary",
				summary: "X",
				start: { dateTime: "2026-08-12T10:00:00" },
				end: { dateTime: "2026-08-12T11:00:00" },
				sendUpdates: "none",
			}),
		).rejects.toThrow("offset");
		expect(requests).toHaveLength(0);
	});

	test("respond_to_event patches this account's own attendance", async () => {
		const { handlers } = await boot();
		const event = {
			id: "e-2",
			summary: "Review",
			attendees: [
				{ email: "organizer@example.com", responseStatus: "accepted" },
				{ email: "me@example.com", self: true, responseStatus: "needsAction" },
			],
		};
		serve([
			[
				/events\/e-2\?sendUpdates=none/,
				(_url, init) => ({ ...event, ...(parseBody(init.body) as object) }),
			],
			[/events\/e-2$/, () => event],
		]);
		const out = result(
			await tool(
				handlers,
				"respond_to_event",
			)({
				calendarId: "primary",
				eventId: "e-2",
				response: "accepted",
				sendUpdates: "none",
			}),
		);
		expect(out.response).toBe("accepted");
		const patch = requests.find((r) => r.method === "PATCH");
		expect(patch?.body).toEqual({
			attendees: [
				{ email: "organizer@example.com", responseStatus: "accepted" },
				{ email: "me@example.com", self: true, responseStatus: "accepted" },
			],
		});
	});

	test("an event this account is not invited to has nothing to respond to", async () => {
		const { handlers } = await boot();
		serve([[/events\/e-3$/, () => ({ id: "e-3", attendees: [{ email: "other@example.com" }] })]]);
		expect(
			tool(
				handlers,
				"respond_to_event",
			)({
				calendarId: "primary",
				eventId: "e-3",
				response: "accepted",
				sendUpdates: "none",
			}),
		).rejects.toThrow("not an attendee");
	});

	test("the calendar tools stay unregistered when the feature is off", async () => {
		const { handlers } = await boot({ vars: { ENABLE_CALENDAR: "false" } });
		for (const name of ["list_calendars", "list_events", "create_event", "respond_to_event"]) {
			expect(handlers.has(name)).toBe(false);
		}
	});
});

describe("accounts and aliases", () => {
	test("set_account_alias survives to whoami and list_accounts", async () => {
		const kv = memoryKv();
		const { handlers } = await boot({ kv });
		serve([[/\/profile/, () => ({ emailAddress: "me@example.com" })]]);
		result(await tool(handlers, "set_account_alias")({ alias: "work" }));
		expect(result(await tool(handlers, "whoami")({})).alias).toBe("work");
		const listed = resultArray(await tool(handlers, "list_accounts")({}));
		expect(listed).toHaveLength(1);
		expect(listed[0]?.alias).toBe("work");
		expect(listed[0]?.thisConnection).toBe(true);
	});

	test("an alias that reads as an address is refused", async () => {
		const { handlers } = await boot();
		serve([]);
		expect(tool(handlers, "set_account_alias")({ alias: "evil@example.com" })).rejects.toThrow(
			"email address",
		);
	});

	test("search_all_accounts groups results per account and aliases them", async () => {
		const kv = memoryKv();
		await putAccount(kv as never, SECRET, {
			email: "me@example.com",
			name: "Me",
			alias: "personal",
			addedAt: "2026-01-01",
			refreshToken: "rt-own",
		});
		await putAccount(kv as never, SECRET, {
			email: "work@example.com",
			name: "Work",
			alias: "work",
			addedAt: "2026-01-01",
			refreshToken: "rt-work",
		});
		const { handlers } = await boot({ kv });
		serve([
			[/oauth2\.googleapis\.com\/token/, () => ({ access_token: "cross-token", expires_in: 3600 })],
			[
				/gmail\/v1\/users\/me\/messages\?/,
				() => ({ messages: [{ id: "m-9" }], resultSizeEstimate: 1 }),
			],
			[
				/messages\/m-9\?format=metadata/,
				() =>
					metadataMessage({ From: "Alice <alice@example.com>", Subject: "Invoice", Date: "now" }),
			],
		]);
		const out = result(
			await tool(handlers, "search_all_accounts")({ query: "invoice", maxResultsPerAccount: 5 }),
		);
		const groups = out.accounts as { account: string; alias?: string; messages?: unknown[] }[];
		expect(groups.map((g) => g.account).sort()).toEqual(["me@example.com", "work@example.com"]);
		for (const group of groups) expect(group.messages).toHaveLength(1);
		// The other account's mailbox was reached with a token minted from its
		// own stored refresh token, not this session's.
		const refresh = requests.find((r) => r.url.includes("oauth2.googleapis.com"));
		expect((refresh?.body as { refresh_token: string } | undefined)?.refresh_token).toBe("rt-work");
	});

	test("a filter to one alias searches only that account", async () => {
		const kv = memoryKv();
		await putAccount(kv as never, SECRET, {
			email: "me@example.com",
			name: "Me",
			addedAt: "2026-01-01",
			refreshToken: "rt-own",
		});
		await putAccount(kv as never, SECRET, {
			email: "work@example.com",
			name: "Work",
			alias: "work",
			addedAt: "2026-01-01",
			refreshToken: "rt-work",
		});
		const { handlers } = await boot({ kv });
		serve([
			[/oauth2\.googleapis\.com\/token/, () => ({ access_token: "t", expires_in: 3600 })],
			[/messages\?/, () => ({ messages: [], resultSizeEstimate: 0 })],
		]);
		const out = result(
			await tool(
				handlers,
				"search_all_accounts",
			)({
				query: "x",
				maxResultsPerAccount: 5,
				accounts: ["work"],
			}),
		);
		expect((out.accounts as { account: string }[]).map((g) => g.account)).toEqual([
			"work@example.com",
		]);
	});

	test("naming an account nothing answers to fails legibly", async () => {
		const kv = memoryKv();
		await putAccount(kv as never, SECRET, {
			email: "me@example.com",
			name: "Me",
			addedAt: "2026-01-01",
		});
		const { handlers } = await boot({ kv });
		serve([]);
		expect(
			tool(
				handlers,
				"search_all_accounts",
			)({
				query: "x",
				maxResultsPerAccount: 5,
				accounts: ["nobody"],
			}),
		).rejects.toThrow("list_accounts");
	});

	// An account that signed in before the feature existed has no stored
	// credentials; its group must say so rather than vanish.
	test("an account without stored credentials reports instead of vanishing", async () => {
		const kv = memoryKv();
		await putAccount(kv as never, SECRET, {
			email: "me@example.com",
			name: "Me",
			addedAt: "2026-01-01",
			refreshToken: "rt-own",
		});
		await putAccount(kv as never, SECRET, {
			email: "old@example.com",
			name: "Old",
			addedAt: "2025-01-01",
		});
		const { handlers } = await boot({ kv });
		serve([[/messages\?/, () => ({ messages: [], resultSizeEstimate: 0 })]]);
		const out = result(
			await tool(handlers, "search_all_accounts")({ query: "x", maxResultsPerAccount: 5 }),
		);
		const old = (out.accounts as { account: string; error?: string }[]).find(
			(g) => g.account === "old@example.com",
		);
		expect(old?.error).toContain("sign it in again");
	});

	test("cross-account search stays unregistered when the feature is off", async () => {
		const { handlers } = await boot({ vars: { ENABLE_CROSS_ACCOUNT: "false" } });
		expect(handlers.has("search_all_accounts")).toBe(false);
	});

	test("with the feature off, list_accounts shows only this connection", async () => {
		const kv = memoryKv();
		await putAccount(kv as never, SECRET, {
			email: "me@example.com",
			name: "Me",
			addedAt: "2026-01-01",
		});
		await putAccount(kv as never, SECRET, {
			email: "other@example.com",
			name: "Other",
			addedAt: "2026-01-01",
		});
		const { handlers } = await boot({ kv, vars: { ENABLE_CROSS_ACCOUNT: "false" } });
		serve([]);
		const listed = resultArray(await tool(handlers, "list_accounts")({}));
		expect(listed.map((r) => r.email)).toEqual(["me@example.com"]);
	});
});
