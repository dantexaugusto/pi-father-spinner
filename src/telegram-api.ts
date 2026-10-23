/**
 * Telegram Bot API helper module for Pi-Father Spinner and Multi-Instance Telegram Bridge.
 * Zero external dependencies — uses native Node 24 fetch.
 */

export interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: {
		retry_after?: number;
	};
}

export interface TelegramBotUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

export interface TelegramBotName {
	name: string;
}

export interface TelegramBotShortDescription {
	short_description: string;
}

export interface TelegramBotDescription {
	description: string;
}

export interface TelegramBotCommand {
	command: string;
	description: string;
}

export class TelegramApiError extends Error {
	readonly errorCode?: number;
	readonly retryAfter?: number;

	constructor(message: string, errorCode?: number, retryAfter?: number) {
		super(message);
		this.name = "TelegramApiError";
		this.errorCode = errorCode;
		this.retryAfter = retryAfter;
	}
}

export async function callTelegramApi<TResponse>(
	botToken: string,
	method: string,
	body: Record<string, unknown> = {},
	options?: { signal?: AbortSignal },
): Promise<TResponse> {
	const token = botToken.trim();
	if (!token) {
		throw new TelegramApiError("Telegram bot token is empty");
	}

	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: options?.signal,
	});

	const data = (await response.json()) as TelegramApiResponse<TResponse>;
	if (!data.ok || data.result === undefined) {
		const retryAfter = data.parameters?.retry_after;
		const suffix = retryAfter ? ` (retry_after: ${retryAfter}s)` : "";
		throw new TelegramApiError(
			`${data.description || `Telegram API ${method} failed`}${suffix}`,
			data.error_code,
			retryAfter,
		);
	}
	return data.result;
}

/**
 * Validates a bot token and returns bot identity (id, username, first_name).
 */
export async function getBotMe(botToken: string, signal?: AbortSignal): Promise<TelegramBotUser> {
	return callTelegramApi<TelegramBotUser>(botToken, "getMe", {}, { signal });
}

/**
 * Gets the bot's current display name (up to 64 chars).
 */
export async function getBotDisplayName(
	botToken: string,
	languageCode?: string,
	signal?: AbortSignal,
): Promise<string> {
	const payload: Record<string, unknown> = {};
	if (languageCode) payload.language_code = languageCode;
	const res = await callTelegramApi<TelegramBotName>(botToken, "getMyName", payload, { signal });
	return res.name;
}

/**
 * Changes the bot's display name (`setMyName`) visible in chats, headers, and notifications.
 * Name must be 0-64 characters. Empty string resets custom name for the given language.
 */
export async function setBotDisplayName(
	botToken: string,
	name: string,
	languageCode?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const trimmed = name.trim().slice(0, 64);
	const payload: Record<string, unknown> = { name: trimmed };
	if (languageCode) payload.language_code = languageCode;
	return callTelegramApi<boolean>(botToken, "setMyName", payload, { signal });
}

/**
 * Changes the bot's short description (`setMyShortDescription`, 0-120 chars),
 * shown on the bot's profile page and when sharing links.
 */
export async function setBotShortDescription(
	botToken: string,
	shortDescription: string,
	languageCode?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const trimmed = shortDescription.trim().slice(0, 120);
	const payload: Record<string, unknown> = { short_description: trimmed };
	if (languageCode) payload.language_code = languageCode;
	return callTelegramApi<boolean>(botToken, "setMyShortDescription", payload, { signal });
}

/**
 * Changes the bot's main description (`setMyDescription`, 0-512 chars),
 * shown in empty chats before clicking Start.
 */
export async function setBotDescription(
	botToken: string,
	description: string,
	languageCode?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const trimmed = description.trim().slice(0, 512);
	const payload: Record<string, unknown> = { description: trimmed };
	if (languageCode) payload.language_code = languageCode;
	return callTelegramApi<boolean>(botToken, "setMyDescription", payload, { signal });
}

/**
 * Registers slash commands in the Telegram chat menu (`setMyCommands`).
 */
export async function setBotCommands(
	botToken: string,
	commands: TelegramBotCommand[],
	signal?: AbortSignal,
): Promise<boolean> {
	return callTelegramApi<boolean>(botToken, "setMyCommands", { commands }, { signal });
}

/**
 * Sends a direct message from a bot to a specific chat_id.
 */
export async function sendBotMessage(
	botToken: string,
	chatId: number | string,
	text: string,
	signal?: AbortSignal,
): Promise<{ message_id: number }> {
	return callTelegramApi<{ message_id: number }>(
		botToken,
		"sendMessage",
		{ chat_id: chatId, text },
		{ signal },
	);
}

/**
 * Masks a bot token for safe display in logs/UI (e.g. "123456789:ABC...XYZ").
 */
export function maskBotToken(token: string): string {
	const trimmed = token.trim();
	const colonIdx = trimmed.indexOf(":");
	if (colonIdx === -1 || trimmed.length < 16) return "***";
	const idPart = trimmed.slice(0, colonIdx);
	const secretPart = trimmed.slice(colonIdx + 1);
	if (secretPart.length <= 6) return `${idPart}:***`;
	return `${idPart}:${secretPart.slice(0, 3)}...${secretPart.slice(-3)}`;
}
