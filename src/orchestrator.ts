/**
 * Core Orchestrator for Pi-Father Spinner.
 *
 * Coordinates:
 * - Durable SQLite state (`DurableFatherStore`)
 * - Telegram Bot API (`getBotMe`, `setBotDisplayName`, `setBotShortDescription`, `sendBotMessage`)
 * - Per-agent isolated Telegram config files
 * - Tmux session lifecycle & automatic crash recovery (`reconcileAgents`)
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type BotPoolRecord,
	type DurableFatherStore,
	getAgentConfigsDir,
	type SpunAgentRecord,
} from "./store.ts";
import {
	getBotDisplayName,
	getBotMe,
	sendBotMessage,
	setBotCommands,
	setBotDisplayName,
	setBotShortDescription,
} from "./telegram-api.ts";
import {
	buildTmuxSessionName,
	captureTmuxPane,
	hasTmuxSession,
	killTmuxSession,
	sanitizeSlug,
	sendTmuxKeys,
	spawnPiTmuxSession,
} from "./tmux.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_PROJECTS_ROOT = process.env.PI_PROJECTS_ROOT || join(homedir(), "projects");
export const DEFAULT_FATHER_TELEGRAM_CONFIG =
	process.env.PI_TELEGRAM_CONFIG || join(homedir(), ".pi", "agent", "telegram.json");
export const DEFAULT_TELEGRAM_EXTENSION_PATH = resolve(__dirname, "..", "extensions", "telegram.ts");

export interface ChildTelegramConfigFile {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	displayName?: string;
	allowedUserId?: number;
	lastUpdateId?: number;
	autoConnect?: boolean;
	agentName?: string;
}

export interface SpinUpAgentOptions {
	name: string;
	cwd?: string;
	createDir?: boolean;
	displayName?: string;
	shortDescription?: string;
	botIdentifier?: string | number;
	allowedUserId?: number;
	continueSession?: boolean;
	model?: string;
	initialPrompt?: string;
	autoRecover?: boolean;
	sendWelcomeMessage?: boolean;
}

export interface SpinUpAgentResult {
	agent: SpunAgentRecord;
	bot: BotPoolRecord;
	telegramUrl: string;
	renameApplied: boolean;
	renameWarning?: string;
	welcomeSent: boolean;
}

export interface ReconcileReport {
	checked: number;
	alive: string[];
	recovered: string[];
	crashed: string[];
	errors: Array<{ name: string; error: string }>;
}

export function resolveProjectCwd(name: string, rawCwd?: string): string {
	const trimmed = rawCwd?.trim();
	if (!trimmed) {
		return join(DEFAULT_PROJECTS_ROOT, sanitizeSlug(name) || name.trim());
	}
	if (trimmed.startsWith("~/")) {
		return join(homedir(), trimmed.slice(2));
	}
	if (isAbsolute(trimmed)) {
		return resolve(trimmed);
	}
	return resolve(DEFAULT_PROJECTS_ROOT, trimmed);
}

export async function readFatherAllowedUserId(
	fatherConfigPath = DEFAULT_FATHER_TELEGRAM_CONFIG,
): Promise<number | undefined> {
	try {
		const raw = await readFile(fatherConfigPath, "utf8");
		const parsed = JSON.parse(raw) as ChildTelegramConfigFile;
		return typeof parsed.allowedUserId === "number" ? parsed.allowedUserId : undefined;
	} catch {
		return undefined;
	}
}

export async function writeChildTelegramConfig(
	configPath: string,
	config: ChildTelegramConfigFile,
): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	let existing: ChildTelegramConfigFile = {};
	try {
		const raw = await readFile(configPath, "utf8");
		existing = JSON.parse(raw) as ChildTelegramConfigFile;
	} catch {
		// ignore if file does not exist yet
	}

	const sameBot = existing.botId !== undefined && existing.botId === config.botId;
	const merged: ChildTelegramConfigFile = {
		...existing,
		...config,
		lastUpdateId: sameBot ? (config.lastUpdateId ?? existing.lastUpdateId) : config.lastUpdateId,
	};

	await writeFile(configPath, `${JSON.stringify(merged, null, "\t")}\n`, "utf8");
}

export class FatherOrchestrator {
	readonly store: DurableFatherStore;
	readonly configsDir: string;
	readonly telegramExtensionPath: string;

	constructor(options: {
		store: DurableFatherStore;
		configsDir?: string;
		telegramExtensionPath?: string;
	}) {
		this.store = options.store;
		this.configsDir = options.configsDir ?? getAgentConfigsDir();
		this.telegramExtensionPath = options.telegramExtensionPath ?? DEFAULT_TELEGRAM_EXTENSION_PATH;
	}

	/**
	 * Validates a Telegram bot token against the Bot API and registers it in the durable pool.
	 */
	async addBotToPool(botToken: string, customDefaultName?: string): Promise<BotPoolRecord> {
		const cleanToken = botToken.trim();
		const me = await getBotMe(cleanToken);
		if (!me.username) {
			throw new Error(`Telegram bot (id=${me.id}) has no username.`);
		}

		let currentTelegramName = me.first_name;
		try {
			const fetchedName = await getBotDisplayName(cleanToken);
			if (fetchedName && fetchedName.trim().length > 0) {
				currentTelegramName = fetchedName.trim();
			}
		} catch {
			// fallback to me.first_name
		}

		const defaultName = customDefaultName?.trim() || currentTelegramName || `Pi Bot (@${me.username})`;
		return this.store.upsertBot({
			botId: me.id,
			botToken: cleanToken,
			botUsername: me.username,
			defaultName,
			currentName: currentTelegramName,
		});
	}

	/**
	 * Imports multiple bot tokens from a JSON file (`string[]` or `Array<{ token: string; defaultName?: string }>`).
	 */
	async syncBotsFromJsonFile(filePath: string): Promise<{ added: BotPoolRecord[]; errors: string[] }> {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const items: Array<{ token: string; defaultName?: string }> = [];

		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (typeof entry === "string" && entry.trim()) {
					items.push({ token: entry.trim() });
				} else if (typeof entry === "object" && entry !== null && "token" in entry) {
					const obj = entry as { token?: unknown; defaultName?: unknown };
					if (typeof obj.token === "string" && obj.token.trim()) {
						items.push({
							token: obj.token.trim(),
							defaultName: typeof obj.defaultName === "string" ? obj.defaultName : undefined,
						});
					}
				}
			}
		} else if (typeof parsed === "object" && parsed !== null && "bots" in parsed) {
			const botsArr = (parsed as { bots?: unknown }).bots;
			if (Array.isArray(botsArr)) {
				for (const entry of botsArr) {
					if (typeof entry === "string" && entry.trim()) {
						items.push({ token: entry.trim() });
					} else if (typeof entry === "object" && entry !== null && "token" in entry) {
						const obj = entry as { token?: unknown; defaultName?: unknown };
						if (typeof obj.token === "string" && obj.token.trim()) {
							items.push({
								token: obj.token.trim(),
								defaultName: typeof obj.defaultName === "string" ? obj.defaultName : undefined,
							});
						}
					}
				}
			}
		}

		const added: BotPoolRecord[] = [];
		const errors: string[] = [];

		for (const item of items) {
			try {
				const record = await this.addBotToPool(item.token, item.defaultName);
				added.push(record);
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}

		return { added, errors };
	}

	/**
	 * Renames a bot's display name (`setMyName`) and optionally its short description (`setMyShortDescription`).
	 * Target can be an active agent name (e.g. "busca-editais"), a `@botUsername`, or numeric `botId`.
	 */
	async renameBot(options: {
		target: string | number;
		newDisplayName: string;
		shortDescription?: string;
		languageCode?: string;
	}): Promise<{ bot: BotPoolRecord; agent?: SpunAgentRecord }> {
		const targetStr = String(options.target).trim();
		let agent = this.store.getAgent(targetStr) ?? this.store.getAgent(sanitizeSlug(targetStr));
		let bot = agent ? this.store.getBotById(agent.botId) : this.store.findBot(options.target);

		if (!bot) {
			throw new Error(
				`Could not find any agent or pooled bot matching "${options.target}". Check father_list_agents or father_bot_pool.`,
			);
		}

		const cleanName = options.newDisplayName.trim().slice(0, 64);
		if (!cleanName) {
			throw new Error("New display name cannot be empty.");
		}

		await setBotDisplayName(bot.botToken, cleanName, options.languageCode);
		if (options.shortDescription !== undefined) {
			await setBotShortDescription(bot.botToken, options.shortDescription, options.languageCode);
		}

		this.store.updateBotDisplayName(bot.botId, cleanName);
		bot = this.store.getBotById(bot.botId)!;

		if (bot.assignedAgentName) {
			agent = this.store.getAgent(bot.assignedAgentName);
			if (agent) {
				await writeChildTelegramConfig(agent.configPath, {
					botToken: bot.botToken,
					botId: bot.botId,
					botUsername: bot.botUsername,
					displayName: cleanName,
					allowedUserId: agent.allowedUserId ?? undefined,
					autoConnect: true,
					agentName: agent.name,
				});
			}
		}

		return { bot, agent };
	}

	/**
	 * Spins up a new child Pi agent in a dedicated tmux session and binds it to an available Telegram bot.
	 */
	async spinUpAgent(options: SpinUpAgentOptions): Promise<SpinUpAgentResult> {
		const slug = sanitizeSlug(options.name);
		if (!slug) {
			throw new Error(`Invalid agent name: "${options.name}"`);
		}

		// Reconcile status of any existing agent with the same slug first
		const existing = this.store.getAgent(slug);
		if (existing && existing.status === "running") {
			const tmuxAlive = await hasTmuxSession(existing.tmuxSession);
			if (!tmuxAlive) {
				this.store.markAgentStatus(slug, "crashed");
			}
		}

		const cwd = resolveProjectCwd(slug, options.cwd);
		if (options.createDir !== false) {
			await mkdir(cwd, { recursive: true });
		} else {
			const st = await stat(cwd).catch(() => null);
			if (!st || !st.isDirectory()) {
				throw new Error(`Directory does not exist: ${cwd}`);
			}
		}

		const tmuxSession = buildTmuxSessionName(slug);
		if (await hasTmuxSession(tmuxSession)) {
			throw new Error(
				`Tmux session "${tmuxSession}" is already running on this VM. Stop it first or choose a different agent name.`,
			);
		}

		const displayName = (options.displayName?.trim() || `Pi • ${slug}`).slice(0, 64);
		const configPath = join(this.configsDir, `${slug}.json`);
		const allowedUserId =
			options.allowedUserId ?? (await readFatherAllowedUserId()) ?? null;

		const { agent, bot } = this.store.allocateBotForAgent({
			name: slug,
			tmuxSession,
			cwd,
			displayName,
			configPath,
			allowedUserId,
			model: options.model ?? null,
			initialPrompt: options.initialPrompt ?? null,
			autoRecover: options.autoRecover ?? true,
			preferredBotIdentifier: options.botIdentifier,
		});

		try {
			// 1. Write the isolated Telegram config file for this child session
			await writeChildTelegramConfig(configPath, {
				botToken: bot.botToken,
				botId: bot.botId,
				botUsername: bot.botUsername,
				displayName,
				allowedUserId: allowedUserId ?? undefined,
				autoConnect: true,
				agentName: slug,
			});

			// 2. Rename the bot's display name on Telegram (`setMyName`) and set commands
			let renameApplied = false;
			let renameWarning: string | undefined;
			try {
				await setBotDisplayName(bot.botToken, displayName);
				if (options.shortDescription) {
					await setBotShortDescription(bot.botToken, options.shortDescription);
				} else {
					await setBotShortDescription(
						bot.botToken,
						`Agente Pi (${slug}) rodando em ${cwd} [tmux: ${tmuxSession}]`,
					).catch(() => undefined);
				}
				await setBotCommands(bot.botToken, [
					{ command: "status", description: "Mostrar modelo, tokens, custo e contexto" },
					{ command: "name", description: "Alterar o nome de exibição deste bot (/name Novo Nome)" },
					{ command: "compact", description: "Compactar histórico de contexto da sessão" },
					{ command: "stop", description: "Interromper o turno em execução" },
					{ command: "help", description: "Mostrar ajuda dos comandos Telegram" },
				]).catch(() => undefined);
				renameApplied = true;
			} catch (err) {
				renameWarning = err instanceof Error ? err.message : String(err);
			}

			// 3. Spawn the detached tmux session running `pi` with the Telegram extension auto-connected
			await spawnPiTmuxSession({
				sessionName: tmuxSession,
				agentName: slug,
				cwd,
				telegramConfigPath: configPath,
				telegramExtensionPath: this.telegramExtensionPath,
				continueSession: options.continueSession,
				model: options.model,
				initialPrompt: options.initialPrompt,
			});

			// 4. Send a welcome message from the child bot to the owner so the conversation pops up in Telegram
			let welcomeSent = false;
			if (options.sendWelcomeMessage !== false && allowedUserId !== null) {
				try {
					const welcomeLines = [
						`🚀 Agente "${displayName}" iniciado pelo Pi-Father!`,
						`📂 Diretório: ${cwd}`,
						`🖥️ Sessão tmux: ${tmuxSession}`,
						options.initialPrompt ? `▶️ Tarefa inicial: ${options.initialPrompt}` : `💬 Envie sua mensagem aqui para começar.`,
					];
					await sendBotMessage(bot.botToken, allowedUserId, welcomeLines.join("\n"));
					welcomeSent = true;
				} catch {
					// Ignore if user hasn't initiated chat with this bot before (Telegram requires user to click Start at least once ever)
				}
			}

			return {
				agent: this.store.getAgent(slug)!,
				bot: this.store.getBotById(bot.botId)!,
				telegramUrl: `https://t.me/${bot.botUsername}`,
				renameApplied,
				renameWarning,
				welcomeSent,
			};
		} catch (error) {
			// Rollback allocation if tmux spawn failed
			await killTmuxSession(tmuxSession).catch(() => undefined);
			this.store.releaseAgent(slug);
			throw error;
		}
	}

	/**
	 * Stops a spun agent, terminates its tmux session, frees its bot back to the pool,
	 * and optionally resets the bot's Telegram display name.
	 */
	async stopAgent(
		name: string,
		options?: { resetBotDisplayName?: boolean; customIdleName?: string },
	): Promise<{
		agent: SpunAgentRecord;
		bot?: BotPoolRecord;
		tmuxKilled: boolean;
		botRenamedTo?: string;
		renameWarning?: string;
	}> {
		const slug = sanitizeSlug(name);
		const existing = this.store.getAgent(slug) ?? this.store.getAgent(name.trim());
		if (!existing) {
			throw new Error(`Agent "${name}" not found.`);
		}

		const tmuxKilled = await killTmuxSession(existing.tmuxSession);
		const botBefore = this.store.getBotById(existing.botId);
		const targetIdleName =
			options?.customIdleName?.trim() ||
			(options?.resetBotDisplayName ? botBefore?.defaultName : undefined);

		const { agent, bot } = this.store.releaseAgent(existing.name, targetIdleName);

		let botRenamedTo: string | undefined;
		let renameWarning: string | undefined;
		if (bot && targetIdleName && targetIdleName !== existing.displayName) {
			try {
				await setBotDisplayName(bot.botToken, targetIdleName);
				botRenamedTo = targetIdleName;
			} catch (err) {
				renameWarning = err instanceof Error ? err.message : String(err);
			}
		}

		return {
			agent,
			bot,
			tmuxKilled,
			botRenamedTo,
			renameWarning,
		};
	}

	/**
	 * Lists all spun agents after reconciling their live tmux status.
	 */
	async listAgentsWithLiveStatus(includeStopped = false): Promise<SpunAgentRecord[]> {
		const agents = this.store.listAgents(includeStopped);
		for (const agent of agents) {
			if (agent.status === "running") {
				const alive = await hasTmuxSession(agent.tmuxSession);
				if (!alive) {
					this.store.markAgentStatus(agent.name, "crashed");
				}
			} else if (agent.status === "crashed") {
				const alive = await hasTmuxSession(agent.tmuxSession);
				if (alive) {
					this.store.markAgentStatus(agent.name, "running");
				}
			}
		}
		return this.store.listAgents(includeStopped);
	}

	/**
	 * Durable Reconciliation (inspired by @earendil-works/pi-durable):
	 * Checks all agents expected to be running, detects crashed/missing tmux sessions
	 * (e.g. after VM reboot), and optionally respawns them with `pi -c` (`--continue`)
	 * while preserving their assigned Telegram bot.
	 */
	async reconcileAgents(options?: { autoRecover?: boolean }): Promise<ReconcileReport> {
		const shouldRecover = options?.autoRecover ?? true;
		const candidates = this.store.listAgents(false);
		const report: ReconcileReport = {
			checked: candidates.length,
			alive: [],
			recovered: [],
			crashed: [],
			errors: [],
		};

		for (const agent of candidates) {
			const alive = await hasTmuxSession(agent.tmuxSession);
			if (alive) {
				if (agent.status !== "running") {
					this.store.markAgentStatus(agent.name, "running");
				}
				report.alive.push(agent.name);
				continue;
			}

			// Session is not alive in tmux
			if (!shouldRecover || !agent.autoRecover) {
				this.store.markAgentStatus(agent.name, "crashed");
				report.crashed.push(agent.name);
				continue;
			}

			try {
				await mkdir(agent.cwd, { recursive: true });
				await writeChildTelegramConfig(agent.configPath, {
					botToken: agent.botToken,
					botId: agent.botId,
					botUsername: agent.botUsername,
					displayName: agent.displayName,
					allowedUserId: agent.allowedUserId ?? (await readFatherAllowedUserId()),
					autoConnect: true,
					agentName: agent.name,
				});

				await spawnPiTmuxSession({
					sessionName: agent.tmuxSession,
					agentName: agent.name,
					cwd: agent.cwd,
					telegramConfigPath: agent.configPath,
					telegramExtensionPath: this.telegramExtensionPath,
					continueSession: true,
					model: agent.model,
				});

				this.store.markAgentStatus(agent.name, "running");
				report.recovered.push(agent.name);
			} catch (err) {
				this.store.markAgentStatus(agent.name, "crashed");
				report.crashed.push(agent.name);
				report.errors.push({
					name: agent.name,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return report;
	}

	/**
	 * Captures recent terminal lines from a child agent's tmux session.
	 */
	async inspectAgentTerminal(name: string, lines = 40): Promise<{ agent: SpunAgentRecord; output: string }> {
		const slug = sanitizeSlug(name);
		const agent = this.store.getAgent(slug) ?? this.store.getAgent(name.trim());
		if (!agent) {
			throw new Error(`Agent "${name}" not found.`);
		}
		const output = await captureTmuxPane(agent.tmuxSession, lines);
		return { agent, output };
	}

	/**
	 * Sends text/keys directly to a child agent's tmux terminal pane.
	 */
	async sendInputToAgentTerminal(name: string, text: string, pressEnter = true): Promise<SpunAgentRecord> {
		const slug = sanitizeSlug(name);
		const agent = this.store.getAgent(slug) ?? this.store.getAgent(name.trim());
		if (!agent) {
			throw new Error(`Agent "${name}" not found.`);
		}
		await sendTmuxKeys(agent.tmuxSession, text, pressEnter);
		return agent;
	}
}
