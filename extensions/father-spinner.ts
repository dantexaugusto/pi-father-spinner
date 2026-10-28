/**
 * Pi-Father Spinner Orchestrator Extension
 *
 * Equips the master Pi-Telegram agent ("Pi-Father") with durable state management (SQLite WAL),
 * a pool of pre-created Telegram bots, automatic tmux crash recovery, bot display-name customization
 * (`setMyName`), and tools/commands to spin up, monitor, rename, and stop child Pi agents in tmux.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { DEFAULT_PROJECTS_ROOT, FatherOrchestrator } from "../src/orchestrator.ts";
import { DurableFatherStore } from "../src/store.ts";
import { maskBotToken } from "../src/telegram-api.ts";

const FATHER_SYSTEM_PROMPT_SECTION = `

## Pi-Father Spinner Orchestrator
You are the **Pi-Father**, the persistent master orchestrator of other Pi coding agents on this VM.
You can spin up, configure, rename, monitor, recover, and stop independent Pi coding agents running in dedicated \`tmux\` sessions, each connected to its own Telegram bot from your Bot Pool.

Available Orchestrator Tools:
- \`father_bot_pool\`: Add BotFather tokens to the pool (\`action: "add"\`), list available/assigned bots (\`action: "list"\`), remove a bot (\`action: "remove"\`), or import from a JSON file (\`action: "sync_file"\`).
- \`father_spin_agent\`: Spin up a new Pi coding agent in a dedicated \`tmux\` session (\`pi-<name>\`) inside a project directory (defaults to \`${DEFAULT_PROJECTS_ROOT}/<name>\`), allocate a free Telegram bot from the pool, automatically change the bot's Telegram display name (\`setMyName\`), pre-pair it with the owner's Telegram account, and return the \`https://t.me/<bot_username>\` link.
- \`father_list_agents\`: List all spun Pi agents, their live \`tmux\` status, working directory (\`cwd\`), assigned \`@bot_username\`, and Telegram display name.
- \`father_rename_bot\`: Change the Telegram display name (\`setMyName\`, visible in chat headers/lists) and/or short description (\`setMyShortDescription\`) of any active agent or pooled bot.
- \`father_stop_agent\`: Stop a spun Pi agent, kill its \`tmux\` session, release its Telegram bot back into the available pool, and optionally reset the bot's Telegram display name.
- \`father_inspect_agent\`: Capture the recent terminal output (\`tmux capture-pane\`) of a spun child agent or send terminal keys/commands to it.
- \`father_reconcile_agents\`: Run durable crash-recovery reconciliation — checks all expected running agents in SQLite against live \`tmux\` sessions and respawns any missing ones with \`pi -c\` (\`--continue\`).`;

export default function (pi: ExtensionAPI) {
	// Guard: do not load orchestrator tools inside child agents spawned by Pi-Father
	if (process.env.PI_CHILD_AGENT === "1") {
		return;
	}

	let store: DurableFatherStore | undefined;
	let orchestrator: FatherOrchestrator | undefined;

	function getOrchestrator(): FatherOrchestrator {
		if (!store) {
			store = new DurableFatherStore();
		}
		if (!orchestrator) {
			orchestrator = new FatherOrchestrator({ store });
		}
		return orchestrator;
	}

	function updateFatherFooterStatus(ctx: ExtensionContext): void {
		try {
			const orch = getOrchestrator();
			const bots = orch.store.listBots();
			const freeCount = bots.filter((b) => b.status === "available").length;
			const agents = orch.store.listAgents(false);
			const runningCount = agents.filter((a) => a.status === "running").length;
			const crashedCount = agents.filter((a) => a.status === "crashed").length;

			const theme = ctx.ui.theme;
			const label = theme.fg("accent", "pi-father");
			const runningPart = theme.fg(runningCount > 0 ? "success" : "muted", `${runningCount} active`);
			const crashedPart = crashedCount > 0 ? ` ${theme.fg("error", `${crashedCount} crashed`)}` : "";
			const poolPart = theme.fg("muted", `pool: ${freeCount}/${bots.length} free`);

			ctx.ui.setStatus("father-spinner", `${label} ${runningPart}${crashedPart} ${poolPart}`);
		} catch {
			// ignore status bar errors
		}
	}

	// ─── 1. Tool: father_bot_pool ──────────────────────────────────────────────
	pi.registerTool({
		name: "father_bot_pool",
		label: "Father Bot Pool",
		description:
			"Manage the pool of pre-created Telegram bots (created via @BotFather) used when spinning up new Pi agents. Actions: 'list', 'add' (with botToken), 'remove' (with botIdentifier), or 'sync_file' (with filePath).",
		promptSnippet: "Manage the pool of Telegram bots (list, add token, remove, sync_file).",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("remove"),
				Type.Literal("sync_file"),
			]),
			botToken: Type.Optional(
				Type.String({
					description: "Bot token from @BotFather (required when action='add')",
				}),
			),
			defaultName: Type.Optional(
				Type.String({
					description: "Optional default/idle display name for the bot when action='add'",
				}),
			),
			botIdentifier: Type.Optional(
				Type.String({
					description: "Bot @username or numeric botId (required when action='remove')",
				}),
			),
			filePath: Type.Optional(
				Type.String({
					description: "Path to a JSON file containing bot tokens (required when action='sync_file')",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();

			if (params.action === "add") {
				if (!params.botToken?.trim()) {
					throw new Error("botToken is required when action='add'.");
				}
				const bot = await orch.addBotToPool(params.botToken, params.defaultName);
				updateFatherFooterStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: [
								`✅ Added bot to pool:`,
								`- Username: @${bot.botUsername} (https://t.me/${bot.botUsername})`,
								`- Bot ID: ${bot.botId}`,
								`- Current Display Name: "${bot.currentName}"`,
								`- Default/Idle Name: "${bot.defaultName}"`,
								`- Status: ${bot.status}`,
							].join("\n"),
						},
					],
					details: { bot: { ...bot, botToken: maskBotToken(bot.botToken) } },
				};
			}

			if (params.action === "remove") {
				if (!params.botIdentifier?.trim()) {
					throw new Error("botIdentifier (@username or botId) is required when action='remove'.");
				}
				const removed = orch.store.removeBot(params.botIdentifier.trim());
				updateFatherFooterStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: `🗑️ Removed bot @${removed.botUsername} (id=${removed.botId}) from the pool.`,
						},
					],
					details: { removed: { ...removed, botToken: maskBotToken(removed.botToken) } },
				};
			}

			if (params.action === "sync_file") {
				if (!params.filePath?.trim()) {
					throw new Error("filePath is required when action='sync_file'.");
				}
				const res = await orch.syncBotsFromJsonFile(params.filePath.trim());
				updateFatherFooterStatus(ctx);
				const lines = [
					`Synced ${res.added.length} bot(s) from ${params.filePath}:`,
					...res.added.map((b) => `- @${b.botUsername} ("${b.currentName}") [${b.status}]`),
				];
				if (res.errors.length > 0) {
					lines.push(`Errors (${res.errors.length}):`, ...res.errors.map((e) => `- ${e}`));
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						addedCount: res.added.length,
						errors: res.errors,
					},
				};
			}

			// Default: list
			const bots = orch.store.listBots();
			updateFatherFooterStatus(ctx);
			if (bots.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Bot pool is currently empty. Add a BotFather token using father_bot_pool with action='add' and botToken='123456:ABC...'.",
						},
					],
					details: { bots: [] },
				};
			}

			const lines = [
				`Telegram Bot Pool (${bots.filter((b) => b.status === "available").length} available / ${bots.length} total):`,
				...bots.map(
					(b) =>
						`- @${b.botUsername} (id: ${b.botId}) | Display Name: "${b.currentName}" | Status: ${b.status}${
							b.assignedAgentName ? ` -> agent "${b.assignedAgentName}"` : ""
						} | Token: ${maskBotToken(b.botToken)}`,
				),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					bots: bots.map((b) => ({ ...b, botToken: maskBotToken(b.botToken) })),
				},
			};
		},
	});

	// ─── 2. Tool: father_spin_agent ────────────────────────────────────────────
	pi.registerTool({
		name: "father_spin_agent",
		label: "Father Spin Up Agent",
		description:
			"Spin up a new Pi coding agent in a dedicated tmux session and bind it to an available Telegram bot from the pool. Automatically updates the bot's Telegram display name (setMyName) and pre-authorizes the owner's Telegram user ID.",
		promptSnippet:
			"Spin up a new Pi agent in a tmux session connected to a dedicated Telegram bot from the pool.",
		parameters: Type.Object({
			name: Type.String({
				description: "Unique name/slug for the agent or project (e.g. 'busca-editais', 'auth-refactor')",
			}),
			cwd: Type.Optional(
				Type.String({
					description: `Working directory for the agent. If omitted, defaults to ${DEFAULT_PROJECTS_ROOT}/<name>. Relative paths resolve inside ${DEFAULT_PROJECTS_ROOT}.`,
				}),
			),
			createDir: Type.Optional(
				Type.Boolean({
					description: "Create the working directory if it does not exist yet (default: true)",
				}),
			),
			displayName: Type.Optional(
				Type.String({
					description:
						"Telegram display name (setMyName) for the bot (1-64 chars). Defaults to 'Pi • <name>'.",
				}),
			),
			shortDescription: Type.Optional(
				Type.String({
					description: "Optional Telegram short description (setMyShortDescription, up to 120 chars).",
				}),
			),
			botIdentifier: Type.Optional(
				Type.String({
					description:
						"Optional specific @bot_username or botId from the pool. If omitted, picks the first available bot.",
				}),
			),
			botToken: Type.Optional(
				Type.String({
					description:
						"Optional new Telegram Bot Token from @BotFather (e.g. '123456:ABC...'). If provided, automatically registers this token in the pool and allocates it to this new agent in a single step.",
				}),
			),
			gitRepoUrl: Type.Optional(
				Type.String({
					description:
						"Optional Git repository URL (HTTPS or SSH, e.g. 'https://github.com/owner/repo' or 'git@github.com:owner/repo.git') to automatically clone into the agent's working directory before starting.",
				}),
			),
			continueSession: Type.Optional(
				Type.Boolean({
					description: "Pass -c (--continue) to pi to resume the most recent session in that directory.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Optional model override for the child Pi agent (defaults to 'deepseek.v3.2' on 'amazon-bedrock'; alternatives: 'us.moonshotai.kimi-k3', 'us.anthropic.claude-sonnet-4-6').",
				}),
			),
			initialPrompt: Type.Optional(
				Type.String({
					description: "Optional initial task/prompt to start the child Pi agent with immediately.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();
			const result = await orch.spinUpAgent({
				name: params.name,
				cwd: params.cwd,
				createDir: params.createDir,
				displayName: params.displayName,
				shortDescription: params.shortDescription,
				botIdentifier: params.botIdentifier,
				botToken: params.botToken,
				gitRepoUrl: params.gitRepoUrl,
				continueSession: params.continueSession,
				model: params.model,
				initialPrompt: params.initialPrompt,
			});

			updateFatherFooterStatus(ctx);

			const lines = [
				`🚀 Spun up Pi Agent "${result.agent.name}"!`,
				`- Telegram Bot: @${result.bot.botUsername} (${result.telegramUrl})`,
				`- Display Name: "${result.agent.displayName}"${
					result.renameWarning ? ` (⚠️ Telegram rename warning: ${result.renameWarning})` : " (✅ applied via setMyName)"
				}`,
				`- Tmux Session: ${result.agent.tmuxSession} (attach with: tmux attach -t ${result.agent.tmuxSession})`,
				`- Working Directory: ${result.agent.cwd}`,
				`- Pre-paired User ID: ${result.agent.allowedUserId ?? "none (send /start in Telegram to pair)"}`,
				`- Welcome DM Sent: ${result.welcomeSent ? "yes" : "no (open the link and send a message/start)"}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					agentName: result.agent.name,
					tmuxSession: result.agent.tmuxSession,
					cwd: result.agent.cwd,
					botUsername: result.bot.botUsername,
					displayName: result.agent.displayName,
					telegramUrl: result.telegramUrl,
					renameApplied: result.renameApplied,
					renameWarning: result.renameWarning,
					welcomeSent: result.welcomeSent,
				},
			};
		},
	});

	// ─── 3. Tool: father_list_agents ───────────────────────────────────────────
	pi.registerTool({
		name: "father_list_agents",
		label: "Father List Agents",
		description:
			"List all spun Pi agents managed by Pi-Father, verifying their live tmux session status, working directory, and assigned Telegram bot.",
		promptSnippet: "List all spun Pi agents and their live tmux + Telegram bot status.",
		parameters: Type.Object({
			includeStopped: Type.Optional(
				Type.Boolean({
					description: "Include historical stopped agents (default: false)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();
			const agents = await orch.listAgentsWithLiveStatus(params.includeStopped ?? false);
			updateFatherFooterStatus(ctx);

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No active spun Pi agents." }],
					details: { agents: [] },
				};
			}

			const lines = [
				`Spun Pi Agents (${agents.length}):`,
				...agents.map(
					(a) =>
						`- ${a.name} [${a.status.toUpperCase()}] | Bot: @${a.botUsername} ("${a.displayName}") -> https://t.me/${a.botUsername} | Tmux: ${a.tmuxSession} | CWD: ${a.cwd}`,
				),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					agents: agents.map((a) => ({ ...a, botToken: maskBotToken(a.botToken) })),
				},
			};
		},
	});

	// ─── 4. Tool: father_rename_bot ────────────────────────────────────────────
	pi.registerTool({
		name: "father_rename_bot",
		label: "Father Rename Telegram Bot",
		description:
			"Change the Telegram display name (setMyName) and/or short description (setMyShortDescription) of any active spun agent or any bot in the pool.",
		promptSnippet: "Change the Telegram display name (setMyName) of an agent's bot or a pooled bot.",
		parameters: Type.Object({
			target: Type.String({
				description: "Agent name (e.g. 'busca-editais'), bot @username, or numeric botId",
			}),
			displayName: Type.String({
				description: "New display name shown in Telegram chat headers and chat list (1-64 characters)",
			}),
			shortDescription: Type.Optional(
				Type.String({
					description: "Optional new short description for the bot profile (0-120 characters)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();
			const res = await orch.renameBot({
				target: params.target,
				newDisplayName: params.displayName,
				shortDescription: params.shortDescription,
			});
			updateFatherFooterStatus(ctx);

			return {
				content: [
					{
						type: "text",
						text: `✅ Updated Telegram display name for @${res.bot.botUsername}${
							res.agent ? ` (agent: ${res.agent.name})` : ""
						} to "${res.bot.currentName}".`,
					},
				],
				details: {
					botUsername: res.bot.botUsername,
					botId: res.bot.botId,
					displayName: res.bot.currentName,
					agentName: res.agent?.name,
				},
			};
		},
	});

	// ─── 5. Tool: father_stop_agent ────────────────────────────────────────────
	pi.registerTool({
		name: "father_stop_agent",
		label: "Father Stop Agent",
		description:
			"Stop a spun Pi agent, kill its tmux session, release its Telegram bot back into the available pool, and optionally reset the bot's Telegram display name.",
		promptSnippet: "Stop a spun Pi agent, kill its tmux session, and return its Telegram bot to the pool.",
		parameters: Type.Object({
			name: Type.String({
				description: "Name of the spun agent to stop",
			}),
			resetBotDisplayName: Type.Optional(
				Type.Boolean({
					description: "Reset the bot's Telegram display name back to its default idle name (default: true)",
				}),
			),
			customIdleName: Type.Optional(
				Type.String({
					description: "Optional custom display name to set on the bot now that it is free (e.g. 'Pi [Livre]')",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();
			const res = await orch.stopAgent(params.name, {
				resetBotDisplayName: params.resetBotDisplayName ?? true,
				customIdleName: params.customIdleName,
			});
			updateFatherFooterStatus(ctx);

			const lines = [
				`🛑 Stopped agent "${res.agent.name}".`,
				`- Tmux session "${res.agent.tmuxSession}": ${res.tmuxKilled ? "terminated" : "was already stopped"}`,
				`- Bot @${res.agent.botUsername}: released back to pool (status: available)`,
			];
			if (res.botRenamedTo) {
				lines.push(`- Bot Display Name reset to: "${res.botRenamedTo}"`);
			} else if (res.renameWarning) {
				lines.push(`- Bot Display Name reset warning: ${res.renameWarning}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					agentName: res.agent.name,
					tmuxKilled: res.tmuxKilled,
					botUsername: res.agent.botUsername,
					botRenamedTo: res.botRenamedTo,
				},
			};
		},
	});

	// ─── 6. Tool: father_inspect_agent ─────────────────────────────────────────
	pi.registerTool({
		name: "father_inspect_agent",
		label: "Father Inspect / Send to Agent Tmux",
		description:
			"Inspect the recent terminal output of a child Pi agent's tmux session ('capture' action) or send input/keys directly to its tmux pane ('send_keys' action).",
		promptSnippet: "Capture terminal output from or send keys to a child agent's tmux session.",
		parameters: Type.Object({
			name: Type.String({
				description: "Name of the spun agent",
			}),
			action: Type.Optional(
				Type.Union([Type.Literal("capture"), Type.Literal("send_keys")], {
					description: "Default is 'capture'",
				}),
			),
			lines: Type.Optional(
				Type.Number({
					description: "Number of terminal lines to capture (default: 40)",
				}),
			),
			keys: Type.Optional(
				Type.String({
					description: "Text or command to send to the tmux session when action='send_keys'",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const orch = getOrchestrator();
			const action = params.action ?? "capture";

			if (action === "send_keys") {
				if (!params.keys) {
					throw new Error("keys parameter is required when action='send_keys'.");
				}
				const agent = await orch.sendInputToAgentTerminal(params.name, params.keys, true);
				return {
					content: [
						{
							type: "text",
							text: `Sent input to agent "${agent.name}" (tmux: ${agent.tmuxSession}).`,
						},
					],
					details: { agentName: agent.name, tmuxSession: agent.tmuxSession },
				};
			}

			const { agent, output } = await orch.inspectAgentTerminal(params.name, params.lines ?? 40);
			return {
				content: [
					{
						type: "text",
						text: `📺 Tmux output for "${agent.name}" (${agent.tmuxSession}, @${agent.botUsername}):\n\`\`\`text\n${output}\n\`\`\``,
					},
				],
				details: { agentName: agent.name, tmuxSession: agent.tmuxSession },
			};
		},
	});

	// ─── 7. Tool: father_reconcile_agents ──────────────────────────────────────
	pi.registerTool({
		name: "father_reconcile_agents",
		label: "Father Reconcile & Recover Agents",
		description:
			"Run durable crash-recovery reconciliation: checks all agents marked as active in SQLite against live tmux sessions, and automatically respawns any crashed/missing tmux sessions with `pi -c` (--continue) and their assigned Telegram bot.",
		promptSnippet: "Reconcile durable state and auto-recover any crashed child tmux sessions.",
		parameters: Type.Object({
			autoRecover: Type.Optional(
				Type.Boolean({
					description: "Automatically respawn missing tmux sessions with pi -c (default: true)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const orch = getOrchestrator();
			const report = await orch.reconcileAgents({ autoRecover: params.autoRecover ?? true });
			updateFatherFooterStatus(ctx);

			const lines = [
				`🔄 Reconciliation complete (checked: ${report.checked}):`,
				`- Alive: ${report.alive.length > 0 ? report.alive.join(", ") : "none"}`,
				`- Auto-recovered: ${report.recovered.length > 0 ? report.recovered.join(", ") : "none"}`,
				`- Crashed/Unrecovered: ${report.crashed.length > 0 ? report.crashed.join(", ") : "none"}`,
			];
			if (report.errors.length > 0) {
				lines.push(
					`- Errors:`,
					...report.errors.map((e) => `  • ${e.name}: ${e.error}`),
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: report,
			};
		},
	});

	// ─── Slash Commands for Interactive TUI Usage ──────────────────────────────
	pi.registerCommand("father-pool", {
		description: "List or add Telegram bots to the Pi-Father pool (Usage: /father-pool [add <token>])",
		handler: async (args, ctx) => {
			const orch = getOrchestrator();
			const trimmed = args.trim();
			if (trimmed.toLowerCase().startsWith("add ")) {
				const token = trimmed.slice(4).trim();
				try {
					const bot = await orch.addBotToPool(token);
					updateFatherFooterStatus(ctx);
					ctx.ui.notify(`Added @${bot.botUsername} ("${bot.currentName}") to pool!`, "info");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}
			const bots = orch.store.listBots();
			updateFatherFooterStatus(ctx);
			if (bots.length === 0) {
				ctx.ui.notify("Bot pool is empty. Use `/father-pool add <BOT_TOKEN>` to register a bot.", "info");
				return;
			}
			const summary = bots
				.map(
					(b) =>
						`@${b.botUsername} ("${b.currentName}") [${
							b.status === "assigned" ? `assigned:${b.assignedAgentName}` : "free"
						}]`,
				)
				.join(" | ");
			ctx.ui.notify(`Pool (${bots.length}): ${summary}`, "info");
		},
	});

	pi.registerCommand("father-agents", {
		description: "Show active spun Pi agents and their Telegram bots",
		handler: async (_args, ctx) => {
			const orch = getOrchestrator();
			const agents = await orch.listAgentsWithLiveStatus(false);
			updateFatherFooterStatus(ctx);
			if (agents.length === 0) {
				ctx.ui.notify("No active spun Pi agents.", "info");
				return;
			}
			const summary = agents
				.map((a) => `${a.name} (${a.tmuxSession} -> @${a.botUsername} "${a.displayName}") [${a.status}]`)
				.join(" | ");
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("father-spin", {
		description: "Spin up a new Pi agent in tmux (Usage: /father-spin <name> [display name])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify("Usage: /father-spin <project-or-agent-name> [Custom Display Name]", "error");
				return;
			}
			const name = parts[0]!;
			const displayName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
			try {
				const res = await getOrchestrator().spinUpAgent({ name, displayName });
				updateFatherFooterStatus(ctx);
				ctx.ui.notify(
					`Spun up "${res.agent.name}" in tmux "${res.agent.tmuxSession}" -> @${res.bot.botUsername} ("${res.agent.displayName}")`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerCommand("father-stop", {
		description: "Stop a spun Pi agent and free its bot (Usage: /father-stop <name>)",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /father-stop <agent-name>", "error");
				return;
			}
			try {
				const res = await getOrchestrator().stopAgent(name, { resetBotDisplayName: true });
				updateFatherFooterStatus(ctx);
				ctx.ui.notify(
					`Stopped "${res.agent.name}" (${res.agent.tmuxSession}) and released @${res.agent.botUsername}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerCommand("father-recover", {
		description: "Reconcile durable state and respawn any crashed child tmux sessions",
		handler: async (_args, ctx) => {
			try {
				const report = await getOrchestrator().reconcileAgents({ autoRecover: true });
				updateFatherFooterStatus(ctx);
				ctx.ui.notify(
					`Reconciled: ${report.alive.length} alive, ${report.recovered.length} recovered, ${report.crashed.length} crashed`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	// ─── Lifecycle Hooks ───────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		try {
			const orch = getOrchestrator();
			const report = await orch.reconcileAgents({ autoRecover: true });
			updateFatherFooterStatus(ctx);
			if (report.recovered.length > 0) {
				ctx.ui.notify(
					`Pi-Father auto-recovered ${report.recovered.length} agent session(s): ${report.recovered.join(", ")}`,
					"info",
				);
			}
		} catch (err) {
			ctx.ui.notify(
				`Pi-Father store initialization warning: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + FATHER_SYSTEM_PROMPT_SECTION,
		};
	});

	pi.on("session_shutdown", async () => {
		store?.close();
		store = undefined;
		orchestrator = undefined;
	});
}
