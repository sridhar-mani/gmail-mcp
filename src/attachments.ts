import { DurableObject } from "cloudflare:workers";

const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const STAGED_CHUNK_CHARS = 1_000_000;
const MAX_APPEND_CHARS = 1_000_000;
const MAX_ENCODED_ATTACHMENT_BYTES = 14_000_000;
const MAX_RAW_UPLOAD_BYTES = 10_000_000;
const MAX_STAGED_TOTAL_CHARS = 32_000_000;

type StagedMeta = {
	filename: string;
	contentType: string;
	secret: string;
	at: number;
	sealed: boolean;
	chunks: number;
	encodedLength: number;
	padding: number;
};

export type StagedAttachment = {
	filename: string;
	contentType: string;
	content: string;
};

function bytesToB64(bytes: Uint8Array): string {
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

export class AttachmentStore extends DurableObject<Env> {
	private async sweep(): Promise<number> {
		const entries = await this.ctx.storage.list<StagedMeta>({ prefix: "staged:" });
		const dead: string[] = [];
		let liveChars = 0;
		for (const [key, meta] of entries) {
			if (key.includes(":chunk:")) continue;
			if (Date.now() - meta.at > STAGED_TTL_MS) {
				dead.push(key);
				for (let i = 0; i < meta.chunks; i++) {
					dead.push(`${key}:chunk:${i}`);
				}
			} else {
				liveChars += meta.encodedLength;
			}
		}
		for (let i = 0; i < dead.length; i += 128) {
			await this.ctx.storage.delete(dead.slice(i, i + 128));
		}
		return liveChars;
	}

	private async meta(stagingId: string): Promise<StagedMeta> {
		const value = await this.ctx.storage.get<StagedMeta>(`staged:${stagingId}`);
		if (!value || Date.now() - value.at > STAGED_TTL_MS) {
			throw new Error("staged attachment not found or expired; begin a new staging");
		}
		return value;
	}

	async begin(filename: string, contentType: string) {
		if (/[\\r\\n\\0]/.test(filename)) {
			throw new Error("filename contains a line break or NUL");
		}
		if (!/^[\\w.+-]+\\/[\\w.+-]+$/.test(contentType)) {
			throw new Error(`invalid content type: ${contentType}`);
		}
		if ((await this.sweep()) > MAX_STAGED_TOTAL_CHARS) {
			throw new Error("staging store is full");
		}
		const stagingId = crypto.randomUUID();
		const secret = crypto.randomUUID();
		const at = Date.now();
		const value: StagedMeta = {
			filename,
			contentType,
			secret,
			at,
			sealed: false,
			chunks: 0,
			encodedLength: 0,
			padding: 0,
		};
		await this.ctx.storage.put(`staged:${stagingId}`, value);
		return {
			stagingId,
			secret,
			expiresAt: new Date(at + STAGED_TTL_MS).toISOString(),
		};
	}

	async append(stagingId: string, content: string) {
		const meta = await this.meta(stagingId);
		if (meta.sealed) {
			throw new Error("staging is already finished; begin a new one to replace it");
		}
		if (meta.padding > 0) {
			throw new Error("an earlier chunk ended with padding, which closes the file");
		}
		const cleaned = content.replace(/\\s+/g, "");
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
			throw new Error("content must be standard base64 in whole four-character groups");
		}
		if (!cleaned.length || cleaned.length > MAX_APPEND_CHARS) {
			throw new Error(`append between 4 and ${MAX_APPEND_CHARS} characters`);
		}
		if (meta.encodedLength + cleaned.length > MAX_ENCODED_ATTACHMENT_BYTES) {
			throw new Error(`this file would exceed the ${MAX_ENCODED_ATTACHMENT_BYTES}-character ceiling`);
		}
		await this.ctx.storage.put(`staged:${stagingId}:chunk:${meta.chunks}`, cleaned);
		const next = {
			...meta,
			chunks: meta.chunks + 1,
			encodedLength: meta.encodedLength + cleaned.length,
			padding: (cleaned.match(/=/g) ?? []).length,
		};
		await this.ctx.storage.put(`staged:${stagingId}`, next);
		return { stagingId, encodedLength: next.encodedLength };
	}

	async finish(stagingId: string) {
		const meta = await this.meta(stagingId);
		if (meta.chunks === 0 || meta.encodedLength === 0) {
			throw new Error("cannot finish an empty attachment");
		}
		const sealed = meta.sealed ? meta : { ...meta, sealed: true };
		if (!meta.sealed) {
			await this.ctx.storage.put(`staged:${stagingId}`, sealed);
		}
		return {
			stagingId,
			filename: sealed.filename,
			contentType: sealed.contentType,
			size: (sealed.encodedLength / 4) * 3 - sealed.padding,
			expiresAt: new Date(sealed.at + STAGED_TTL_MS).toISOString(),
		};
	}

	async getContent(stagingId: string): Promise<StagedAttachment> {
		const meta = await this.meta(stagingId);
		if (!meta.sealed) {
			throw new Error("staged attachment is not finished; call stage_attachment_finish");
		}
		const parts: string[] = [];
		for (let i = 0; i < meta.chunks; i++) {
			const chunk = await this.ctx.storage.get<string>(`staged:${stagingId}:chunk:${i}`);
			if (chunk === undefined) {
				throw new Error("staged attachment lost a chunk; stage it again");
			}
			parts.push(chunk);
		}
		return { filename: meta.filename, contentType: meta.contentType, content: parts.join("") };
	}

	async acceptUpload(stagingId: string, secret: string, bytes: Uint8Array) {
		const meta = await this.meta(stagingId);
		if (meta.secret !== secret) {
			throw new Error("invalid upload secret");
		}
		if (meta.sealed || meta.chunks > 0) {
			throw new Error("staging already contains data");
		}
		if (bytes.byteLength > MAX_RAW_UPLOAD_BYTES) {
			throw new Error(`upload exceeds ${MAX_RAW_UPLOAD_BYTES} bytes`);
		}
		const encoded = bytesToB64(bytes);
		if (encoded.length > MAX_ENCODED_ATTACHMENT_BYTES) {
			throw new Error("encoded attachment exceeds message limit");
		}
		const chunks = Math.ceil(encoded.length / STAGED_CHUNK_CHARS);
		for (let i = 0; i < chunks; i++) {
			await this.ctx.storage.put(
				`staged:${stagingId}:chunk:${i}`,
					encoded.slice(i * STAGED_CHUNK_CHARS, (i + 1) * STAGED_CHUNK_CHARS),
			);
		}
		await this.ctx.storage.put(`staged:${stagingId}`, {
			...meta,
			sealed: true,
			chunks,
			encodedLength: encoded.length,
			padding: encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0,
		} satisfies StagedMeta);
		return {
			stagingId,
			filename: meta.filename,
			contentType: meta.contentType,
			size: bytes.byteLength,
		};
	}
}
