#!/usr/bin/env -S node --experimental-strip-types
/**
 * Non-interactive provisioning helper for Pi-Father Spinner.
 *
 * Used by Terraform (`remote-exec`) or CLI to:
 * 1. Configure ~/.pi/agent/telegram.json for the Pi-Father (if FATHER_BOT_TOKEN is set).
 * 2. Sync a bots-pool.json file into the durable SQLite store (`state.sqlite`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { FatherOrchestrator } from "../src/orchestrator.ts";
import { DurableFatherStore } from "../src/store.ts";
import { getBotDisplayName, getBotMe, setBotCommands } from "../src/telegram-api.ts";

async function configureFatherBotIfProvided(): Promise<void> {
	const token = process.env.FATHER_BOT_TOKEN?.trim();
	if (!token) return;

	const configPath = process.env.PI_TELEGRAM_CONFIG || join(homedir(), ".pi", "agent", "telegram.json");
	await mkdir(dirname(configPath), { recursive: true });

	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		// ignore if not found
	}

	const me = await getBotMe(token);
	let displayName = me.first_name;
	try {
		displayName = (await getBotDisplayName(token)) || me.first_name;
	} catch {
		// fallback
	}

	const allowedUserIdRaw = process.env.ALLOWED_TELEGRAM_USER_ID?.trim();
	const allowedUserId =
		allowedUserIdRaw && /^\d+$/.test(allowedUserIdRaw)
			? Number(allowedUserIdRaw)
			: (existing.allowedUserId as number | undefined);

	const nextConfig = {
		...existing,
		botToken: token,
		botId: me.id,
		botUsername: me.username,
		displayName,
		...(allowedUserId !== undefined ? { allowedUserId } : {}),
		autoConnect: true,
		agentName: "pi-father",
	};

	await writeFile(configPath, `${JSON.stringify(nextConfig, null, "\t")}\n`, "utf8");
	await setBotCommands(token, [
		{ command: "status", description: "Mostrar modelo, tokens, custo e contexto" },
		{ command: "name", description: "Alterar o nome de exibição deste bot (/name Novo Nome)" },
		{ command: "compact", description: "Compactar histórico de contexto da sessão" },
		{ command: "stop", description: "Interromper o turno em execução" },
		{ command: "help", description: "Mostrar ajuda dos comandos Telegram" },
	]).catch(() => undefined);

	console.log(`[sync-pool] Configured Pi-Father Telegram bot: @${me.username} ("${displayName}")`);
}

async function main(): Promise<void> {
	await configureFatherBotIfProvided();

	const poolFile = process.argv[2] || process.env.BOTS_POOL_FILE;
	if (!poolFile) {
		return;
	}

	const store = new DurableFatherStore();
	const orchestrator = new FatherOrchestrator({ store });
	try {
		const res = await orchestrator.syncBotsFromJsonFile(poolFile);
		console.log(`[sync-pool] Synced ${res.added.length} bot(s) into SQLite pool (${store.dbPath}).`);
		for (const bot of res.added) {
			console.log(`  - @${bot.botUsername} ("${bot.currentName}") [${bot.status}]`);
		}
		if (res.errors.length > 0) {
			console.warn(`[sync-pool] Warnings/Errors (${res.errors.length}):`);
			for (const err of res.errors) {
				console.warn(`  ! ${err}`);
			}
		}
	} finally {
		store.close();
	}
}

main().catch((err) => {
	console.error("[sync-pool] Fatal error:", err);
	process.exit(1);
});
