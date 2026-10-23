/**
 * Durable SQLite State Store for Pi-Father Spinner.
 *
 * Inspired by @earendil-works/pi-durable:
 * - Uses SQLite in WAL mode (`synchronous = NORMAL`) via Node 24's built-in `node:sqlite`.
 * - Every allocation, release, or state transition is committed atomically in a transaction,
 *   coupled with an immutable audit entry (`audit_log`), enabling deterministic crash recovery
 *   and tmux session reconciliation on startup.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BotPoolStatus = "available" | "assigned";
export type SpunAgentStatus = "running" | "crashed" | "stopped";

export interface BotPoolRecord {
	botId: number;
	botToken: string;
	botUsername: string;
	defaultName: string;
	currentName: string;
	status: BotPoolStatus;
	assignedAgentName: string | null;
	addedAt: string;
	updatedAt: string;
}

export interface SpunAgentRecord {
	name: string;
	tmuxSession: string;
	cwd: string;
	botId: number;
	botToken: string;
	botUsername: string;
	displayName: string;
	configPath: string;
	allowedUserId: number | null;
	model: string | null;
	initialPrompt: string | null;
	status: SpunAgentStatus;
	autoRecover: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AuditEntryRecord {
	id: number;
	kind: string;
	agentName: string | null;
	botId: number | null;
	dataJson: string;
	createdAt: string;
}

export function getDefaultDataDir(): string {
	return process.env.PI_FATHER_DATA_DIR || join(homedir(), ".pi", "agent", "father-spinner");
}

export function getDefaultDbPath(): string {
	return process.env.PI_FATHER_DB_PATH || join(getDefaultDataDir(), "state.sqlite");
}

export function getAgentConfigsDir(): string {
	return join(getDefaultDataDir(), "configs");
}

export class DurableFatherStore {
	readonly dbPath: string;
	private db: DatabaseSync;

	constructor(dbPath: string = getDefaultDbPath()) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new DatabaseSync(dbPath);
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS bot_pool (
				bot_id INTEGER PRIMARY KEY,
				bot_token TEXT NOT NULL UNIQUE,
				bot_username TEXT NOT NULL,
				default_name TEXT NOT NULL,
				current_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'available',
				assigned_agent_name TEXT,
				added_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS spun_agents (
				name TEXT PRIMARY KEY,
				tmux_session TEXT NOT NULL UNIQUE,
				cwd TEXT NOT NULL,
				bot_id INTEGER NOT NULL,
				bot_token TEXT NOT NULL,
				bot_username TEXT NOT NULL,
				display_name TEXT NOT NULL,
				config_path TEXT NOT NULL,
				allowed_user_id INTEGER,
				model TEXT,
				initial_prompt TEXT,
				status TEXT NOT NULL DEFAULT 'running',
				auto_recover INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS audit_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				agent_name TEXT,
				bot_id INTEGER,
				data_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
	}

	/**
	 * Executes a synchronous callback inside an atomic SQLite transaction (`BEGIN IMMEDIATE`).
	 */
	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore rollback error
			}
			throw error;
		}
	}

	private appendAudit(kind: string, agentName: string | null, botId: number | null, data: Record<string, unknown>): void {
		const now = new Date().toISOString();
		const stmt = this.db.prepare(`
			INSERT INTO audit_log (kind, agent_name, bot_id, data_json, created_at)
			VALUES (?, ?, ?, ?, ?)
		`);
		stmt.run(kind, agentName, botId, JSON.stringify(data), now);
	}

	/**
	 * Registers or updates a Telegram bot in the pool.
	 */
	upsertBot(input: {
		botId: number;
		botToken: string;
		botUsername: string;
		defaultName: string;
		currentName?: string;
	}): BotPoolRecord {
		return this.transaction(() => {
			const now = new Date().toISOString();
			const existing = this.getBotById(input.botId);
			const currentName = input.currentName ?? existing?.currentName ?? input.defaultName;

			if (existing) {
				const stmt = this.db.prepare(`
					UPDATE bot_pool
					SET bot_token = ?,
					    bot_username = ?,
					    default_name = ?,
					    current_name = ?,
					    updated_at = ?
					WHERE bot_id = ?
				`);
				stmt.run(
					input.botToken.trim(),
					input.botUsername,
					input.defaultName,
					currentName,
					now,
					input.botId,
				);
			} else {
				const stmt = this.db.prepare(`
					INSERT INTO bot_pool (
						bot_id, bot_token, bot_username, default_name, current_name,
						status, assigned_agent_name, added_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 'available', NULL, ?, ?)
				`);
				stmt.run(
					input.botId,
					input.botToken.trim(),
					input.botUsername,
					input.defaultName,
					currentName,
					now,
					now,
				);
			}

			this.appendAudit("bot.upserted", existing?.assignedAgentName ?? null, input.botId, {
				botUsername: input.botUsername,
				defaultName: input.defaultName,
				currentName,
			});

			return this.getBotById(input.botId)!;
		});
	}

	getBotById(botId: number): BotPoolRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM bot_pool WHERE bot_id = ?")
			.get(botId) as Record<string, unknown> | undefined;
		return row ? this.mapBotRow(row) : undefined;
	}

	/**
	 * Finds a bot by `@username`, `username`, or numeric `botId`.
	 */
	findBot(identifier: string | number): BotPoolRecord | undefined {
		if (typeof identifier === "number" || /^\d+$/.test(String(identifier).trim())) {
			const id = Number(identifier);
			const byId = this.getBotById(id);
			if (byId) return byId;
		}
		const cleanUsername = String(identifier).trim().replace(/^@/, "").toLowerCase();
		const row = this.db
			.prepare("SELECT * FROM bot_pool WHERE lower(bot_username) = ?")
			.get(cleanUsername) as Record<string, unknown> | undefined;
		return row ? this.mapBotRow(row) : undefined;
	}

	listBots(statusFilter?: BotPoolStatus): BotPoolRecord[] {
		const rows = statusFilter
			? (this.db
					.prepare("SELECT * FROM bot_pool WHERE status = ? ORDER BY added_at ASC")
					.all(statusFilter) as Record<string, unknown>[])
			: (this.db.prepare("SELECT * FROM bot_pool ORDER BY added_at ASC").all() as Record<string, unknown>[]);
		return rows.map((r) => this.mapBotRow(r));
	}

	removeBot(identifier: string | number): BotPoolRecord {
		return this.transaction(() => {
			const bot = this.findBot(identifier);
			if (!bot) {
				throw new Error(`Bot "${identifier}" not found in pool.`);
			}
			if (bot.status === "assigned" && bot.assignedAgentName) {
				const agent = this.getAgent(bot.assignedAgentName);
				if (agent && agent.status === "running") {
					throw new Error(
						`Bot @${bot.botUsername} is currently assigned to running agent "${bot.assignedAgentName}". Stop the agent first.`,
					);
				}
			}
			this.db.prepare("DELETE FROM bot_pool WHERE bot_id = ?").run(bot.botId);
			this.appendAudit("bot.removed", bot.assignedAgentName, bot.botId, {
				botUsername: bot.botUsername,
			});
			return bot;
		});
	}

	updateBotDisplayName(botId: number, newDisplayName: string): void {
		this.transaction(() => {
			const now = new Date().toISOString();
			this.db
				.prepare("UPDATE bot_pool SET current_name = ?, updated_at = ? WHERE bot_id = ?")
				.run(newDisplayName, now, botId);
			this.db
				.prepare("UPDATE spun_agents SET display_name = ?, updated_at = ? WHERE bot_id = ? AND status != 'stopped'")
				.run(newDisplayName, now, botId);
			this.appendAudit("bot.renamed", null, botId, { newDisplayName });
		});
	}

	/**
	 * Atomically allocates a bot from the pool and creates/updates the spun agent record.
	 */
	allocateBotForAgent(input: {
		name: string;
		tmuxSession: string;
		cwd: string;
		displayName: string;
		configPath: string;
		allowedUserId: number | null;
		model?: string | null;
		initialPrompt?: string | null;
		autoRecover?: boolean;
		preferredBotIdentifier?: string | number;
	}): { agent: SpunAgentRecord; bot: BotPoolRecord } {
		return this.transaction(() => {
			const existingAgent = this.getAgent(input.name);
			if (existingAgent && existingAgent.status === "running") {
				throw new Error(
					`Agent "${input.name}" is already registered as running (tmux: ${existingAgent.tmuxSession}, bot: @${existingAgent.botUsername}).`,
				);
			}

			let bot: BotPoolRecord | undefined;
			if (existingAgent && existingAgent.status === "crashed") {
				// Re-use its already assigned bot if recovering
				const prevBot = this.getBotById(existingAgent.botId);
				if (prevBot && (prevBot.status === "available" || prevBot.assignedAgentName === input.name)) {
					bot = prevBot;
				}
			}

			if (!bot && input.preferredBotIdentifier !== undefined) {
				const candidate = this.findBot(input.preferredBotIdentifier);
				if (!candidate) {
					throw new Error(`Preferred bot "${input.preferredBotIdentifier}" was not found in the bot pool.`);
				}
				if (candidate.status === "assigned" && candidate.assignedAgentName !== input.name) {
					throw new Error(
						`Bot @${candidate.botUsername} is already assigned to agent "${candidate.assignedAgentName}".`,
					);
				}
				bot = candidate;
			}

			if (!bot) {
				const available = this.listBots("available");
				if (available.length === 0) {
					throw new Error(
						"No available Telegram bots in the pool! Add a new BotFather token with father_bot_pool (action='add') or stop an unused agent.",
					);
				}
				bot = available[0]!;
			}

			const now = new Date().toISOString();
			this.db
				.prepare(`
					UPDATE bot_pool
					SET status = 'assigned',
					    assigned_agent_name = ?,
					    current_name = ?,
					    updated_at = ?
					WHERE bot_id = ?
				`)
				.run(input.name, input.displayName, now, bot.botId);

			this.db
				.prepare(`
					INSERT INTO spun_agents (
						name, tmux_session, cwd, bot_id, bot_token, bot_username,
						display_name, config_path, allowed_user_id, model, initial_prompt,
						status, auto_recover, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
					ON CONFLICT(name) DO UPDATE SET
						tmux_session = excluded.tmux_session,
						cwd = excluded.cwd,
						bot_id = excluded.bot_id,
						bot_token = excluded.bot_token,
						bot_username = excluded.bot_username,
						display_name = excluded.display_name,
						config_path = excluded.config_path,
						allowed_user_id = excluded.allowed_user_id,
						model = excluded.model,
						initial_prompt = excluded.initial_prompt,
						status = 'running',
						auto_recover = excluded.auto_recover,
						updated_at = excluded.updated_at
				`)
				.run(
					input.name,
					input.tmuxSession,
					input.cwd,
					bot.botId,
					bot.botToken,
					bot.botUsername,
					input.displayName,
					input.configPath,
					input.allowedUserId,
					input.model ?? null,
					input.initialPrompt ?? null,
					input.autoRecover === false ? 0 : 1,
					existingAgent?.createdAt ?? now,
					now,
				);

			this.appendAudit("agent.spun", input.name, bot.botId, {
				tmuxSession: input.tmuxSession,
				cwd: input.cwd,
				botUsername: bot.botUsername,
				displayName: input.displayName,
			});

			return {
				agent: this.getAgent(input.name)!,
				bot: this.getBotById(bot.botId)!,
			};
		});
	}

	getAgent(name: string): SpunAgentRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM spun_agents WHERE name = ?")
			.get(name.trim()) as Record<string, unknown> | undefined;
		return row ? this.mapAgentRow(row) : undefined;
	}

	listAgents(includeStopped = false): SpunAgentRecord[] {
		const rows = includeStopped
			? (this.db.prepare("SELECT * FROM spun_agents ORDER BY updated_at DESC").all() as Record<string, unknown>[])
			: (this.db
					.prepare("SELECT * FROM spun_agents WHERE status != 'stopped' ORDER BY updated_at DESC")
					.all() as Record<string, unknown>[]);
		return rows.map((r) => this.mapAgentRow(r));
	}

	markAgentStatus(name: string, status: SpunAgentStatus): void {
		this.transaction(() => {
			const now = new Date().toISOString();
			const agent = this.getAgent(name);
			if (!agent) return;
			this.db
				.prepare("UPDATE spun_agents SET status = ?, updated_at = ? WHERE name = ?")
				.run(status, now, name);
			this.appendAudit(`agent.status.${status}`, name, agent.botId, { previousStatus: agent.status });
		});
	}

	/**
	 * Stops an agent and releases its Telegram bot back into the available pool.
	 */
	releaseAgent(name: string, restoredBotName?: string): { agent: SpunAgentRecord; bot?: BotPoolRecord } {
		return this.transaction(() => {
			const agent = this.getAgent(name);
			if (!agent) {
				throw new Error(`Spun agent "${name}" not found.`);
			}

			const now = new Date().toISOString();
			this.db
				.prepare("UPDATE spun_agents SET status = 'stopped', updated_at = ? WHERE name = ?")
				.run(now, name);

			const bot = this.getBotById(agent.botId);
			if (bot) {
				const nextName = restoredBotName ?? bot.defaultName;
				this.db
					.prepare(`
						UPDATE bot_pool
						SET status = 'available',
						    assigned_agent_name = NULL,
						    current_name = ?,
						    updated_at = ?
						WHERE bot_id = ?
					`)
					.run(nextName, now, bot.botId);
			}

			this.appendAudit("agent.stopped", name, agent.botId, {
				tmuxSession: agent.tmuxSession,
				restoredBotName: restoredBotName ?? bot?.defaultName,
			});

			return {
				agent: this.getAgent(name)!,
				bot: this.getBotById(agent.botId),
			};
		});
	}

	listRecentAudit(limit = 25): AuditEntryRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
			.all(limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			id: Number(row.id),
			kind: String(row.kind),
			agentName: row.agent_name ? String(row.agent_name) : null,
			botId: row.bot_id !== null && row.bot_id !== undefined ? Number(row.bot_id) : null,
			dataJson: String(row.data_json),
			createdAt: String(row.created_at),
		}));
	}

	close(): void {
		this.db.close();
	}

	private mapBotRow(row: Record<string, unknown>): BotPoolRecord {
		return {
			botId: Number(row.bot_id),
			botToken: String(row.bot_token),
			botUsername: String(row.bot_username),
			defaultName: String(row.default_name),
			currentName: String(row.current_name),
			status: String(row.status) as BotPoolStatus,
			assignedAgentName: row.assigned_agent_name ? String(row.assigned_agent_name) : null,
			addedAt: String(row.added_at),
			updatedAt: String(row.updated_at),
		};
	}

	private mapAgentRow(row: Record<string, unknown>): SpunAgentRecord {
		return {
			name: String(row.name),
			tmuxSession: String(row.tmux_session),
			cwd: String(row.cwd),
			botId: Number(row.bot_id),
			botToken: String(row.bot_token),
			botUsername: String(row.bot_username),
			displayName: String(row.display_name),
			configPath: String(row.config_path),
			allowedUserId: row.allowed_user_id !== null && row.allowed_user_id !== undefined ? Number(row.allowed_user_id) : null,
			model: row.model ? String(row.model) : null,
			initialPrompt: row.initial_prompt ? String(row.initial_prompt) : null,
			status: String(row.status) as SpunAgentStatus,
			autoRecover: Number(row.auto_recover) === 1,
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}
}
