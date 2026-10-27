/**
 * Tmux Session Manager for Pi-Father Spinner.
 *
 * Manages detached tmux sessions running child `pi` coding agents,
 * preserving NVM/Node PATH and passing per-instance Telegram configuration.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxSessionInfo {
	name: string;
	windows: number;
	created: string;
	attached: boolean;
}

export interface SpawnPiTmuxOptions {
	sessionName: string;
	agentName: string;
	cwd: string;
	telegramConfigPath: string;
	telegramExtensionPath: string;
	continueSession?: boolean;
	model?: string | null;
	initialPrompt?: string | null;
	piBinary?: string;
}

export function sanitizeSlug(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function buildTmuxSessionName(agentName: string): string {
	const slug = sanitizeSlug(agentName);
	if (!slug) throw new Error(`Invalid agent name: "${agentName}"`);
	return slug.startsWith("pi-") ? slug : `pi-${slug}`;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Checks whether a specific tmux session currently exists.
 */
export async function hasTmuxSession(sessionName: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["has-session", "-t", `=${sessionName}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Lists all active tmux sessions on the host.
 */
export async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
	try {
		const { stdout } = await execFileAsync("tmux", [
			"list-sessions",
			"-F",
			"#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_attached}",
		]);
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name = "", windows = "1", created = "", attached = "0"] = line.split("\t");
				return {
					name,
					windows: Number(windows) || 1,
					created,
					attached: attached !== "0",
				};
			});
	} catch {
		return [];
	}
}

/**
 * Spawns a new detached tmux session running a child `pi` coding agent
 * pre-connected to its assigned Telegram bot.
 */
export async function spawnPiTmuxSession(options: SpawnPiTmuxOptions): Promise<void> {
	const exists = await hasTmuxSession(options.sessionName);
	if (exists) {
		throw new Error(`Tmux session "${options.sessionName}" already exists.`);
	}

	const piBin = options.piBinary || process.env.PI_BINARY || "pi";
	const currentPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
	const defaultProvider = process.env.PI_DEFAULT_PROVIDER || "amazon-bedrock";
	const selectedModel = options.model?.trim() || process.env.PI_DEFAULT_MODEL || "deepseek.v3.2";
	const awsRegion = process.env.AWS_REGION || "us-east-1";

	const cmdParts: string[] = [
		`export PATH=${shellQuote(currentPath)};`,
		`export AWS_REGION=${shellQuote(awsRegion)};`,
		`[ -f "$HOME/.pi/agent/.env" ] && set -a && . "$HOME/.pi/agent/.env" && set +a;`,
		`export PI_CHILD_AGENT=1;`,
		`export PI_AGENT_NAME=${shellQuote(options.agentName)};`,
		`export PI_TELEGRAM_CONFIG=${shellQuote(options.telegramConfigPath)};`,
		`export PI_TELEGRAM_AUTOCONNECT=1;`,
		`exec ${shellQuote(piBin)}`,
		`-e ${shellQuote(options.telegramExtensionPath)}`,
	];

	if (options.continueSession) {
		cmdParts.push("-c");
	}

	if (!selectedModel.includes("/")) {
		cmdParts.push("--provider", shellQuote(defaultProvider));
	}
	cmdParts.push("--model", shellQuote(selectedModel));

	if (options.initialPrompt && options.initialPrompt.trim().length > 0) {
		cmdParts.push(shellQuote(options.initialPrompt.trim()));
	}

	const shellCommand = cmdParts.join(" ");

	await execFileAsync("tmux", [
		"new-session",
		"-d",
		"-s",
		options.sessionName,
		"-c",
		options.cwd,
		"bash",
		"-lc",
		shellCommand,
	]);
}

/**
 * Kills an active tmux session. Returns true if killed, false if it didn't exist.
 */
export async function killTmuxSession(sessionName: string): Promise<boolean> {
	const exists = await hasTmuxSession(sessionName);
	if (!exists) return false;
	await execFileAsync("tmux", ["kill-session", "-t", `=${sessionName}`]);
	return true;
}

/**
 * Captures the recent visible/scrollback lines of a tmux session's pane.
 */
export async function captureTmuxPane(sessionName: string, lines = 50): Promise<string> {
	const exists = await hasTmuxSession(sessionName);
	if (!exists) {
		throw new Error(`Tmux session "${sessionName}" is not running.`);
	}
	const startLine = -Math.max(1, Math.min(500, lines));
	const { stdout } = await execFileAsync("tmux", [
		"capture-pane",
		"-p",
		"-t",
		sessionName,
		"-S",
		String(startLine),
	]);
	return stdout.trimEnd();
}

/**
 * Sends keys or a line of text to a tmux session's active pane.
 */
export async function sendTmuxKeys(sessionName: string, text: string, pressEnter = true): Promise<void> {
	const exists = await hasTmuxSession(sessionName);
	if (!exists) {
		throw new Error(`Tmux session "${sessionName}" is not running.`);
	}
	await execFileAsync("tmux", ["send-keys", "-t", sessionName, "-l", text]);
	if (pressEnter) {
		await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
	}
}
