import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { FatherOrchestrator } from "../src/orchestrator.ts";
import { DurableFatherStore } from "../src/store.ts";
import { hasTmuxSession, killTmuxSession } from "../src/tmux.ts";

describe("Pi-Father Spinner Durable Store & Orchestrator", () => {
	let tempRoot = "";
	const originalFetch = globalThis.fetch;
	const apiCalls: Array<{ method: string; body: Record<string, unknown>; token: string }> = [];

	before(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "pi-father-test-"));

		// Mock Telegram API endpoints (getMe, getMyName, setMyName, setMyShortDescription, setMyCommands, sendMessage)
		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			const match = url.match(/https:\/\/api\.telegram\.org\/bot([^/]+)\/(.+)$/);
			if (!match) {
				return originalFetch(input, init);
			}
			const [, token = "", method = ""] = match;
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			apiCalls.push({ method, body, token });

			if (method === "getMe") {
				if (token.startsWith("1001:")) {
					return new Response(
						JSON.stringify({
							ok: true,
							result: { id: 1001, is_bot: true, first_name: "Pi Pool 1", username: "pi_pool_1_bot" },
						}),
					);
				}
				if (token.startsWith("1002:")) {
					return new Response(
						JSON.stringify({
							ok: true,
							result: { id: 1002, is_bot: true, first_name: "Pi Pool 2", username: "pi_pool_2_bot" },
						}),
					);
				}
				return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
			}

			if (method === "getMyName") {
				return new Response(
					JSON.stringify({
						ok: true,
						result: { name: token.startsWith("1001:") ? "Pi [Livre 1]" : "Pi [Livre 2]" },
					}),
				);
			}

			if (
				method === "setMyName" ||
				method === "setMyShortDescription" ||
				method === "setMyDescription" ||
				method === "setMyCommands"
			) {
				return new Response(JSON.stringify({ ok: true, result: true }));
			}

			if (method === "sendMessage") {
				return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
			}

			return new Response(JSON.stringify({ ok: true, result: [] }));
		};
	});

	after(async () => {
		globalThis.fetch = originalFetch;
		if (tempRoot) {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("manages bot pool, spins up an agent in tmux, changes bot display name, recovers from crash, and stops cleanly", async () => {
		const dbPath = join(tempRoot, "state.sqlite");
		const configsDir = join(tempRoot, "configs");
		const workDir = join(tempRoot, "demo-project");
		const store = new DurableFatherStore(dbPath);
		const orchestrator = new FatherOrchestrator({ store, configsDir });

		// Create a lightweight fake-pi script that ignores CLI flags and stays alive inside tmux
		const fakePiPath = join(tempRoot, "fake-pi.sh");
		await writeFile(fakePiPath, "#!/usr/bin/env bash\necho \"Fake Pi started with args: $*\"\nsleep 30\n", "utf8");
		await chmod(fakePiPath, 0o755);

		const prevPiBin = process.env.PI_BINARY;
		process.env.PI_BINARY = fakePiPath;

		try {
			// 1. Add two bots to the pool
			const bot1 = await orchestrator.addBotToPool("1001:AAABBBCCC_TOKEN_1");
			const bot2 = await orchestrator.addBotToPool("1002:DDDEEEFFF_TOKEN_2");

			assert.equal(bot1.botUsername, "pi_pool_1_bot");
			assert.equal(bot1.defaultName, "Pi [Livre 1]");
			assert.equal(bot1.status, "available");
			assert.equal(bot2.botUsername, "pi_pool_2_bot");

			// 2. Spin up an agent
			apiCalls.length = 0;
			const spinRes = await orchestrator.spinUpAgent({
				name: "demo-project",
				cwd: workDir,
				displayName: "Pi • Demo Project",
				allowedUserId: 999888777,
			});

			assert.equal(spinRes.agent.name, "demo-project");
			assert.equal(spinRes.agent.tmuxSession, "pi-demo-project");
			assert.equal(spinRes.bot.botUsername, "pi_pool_1_bot");
			assert.equal(spinRes.bot.status, "assigned");
			assert.equal(spinRes.agent.displayName, "Pi • Demo Project");
			assert.equal(spinRes.renameApplied, true);
			assert.equal(spinRes.welcomeSent, true);

			// Verify setMyName was called with the new display name
			const setMyNameCall = apiCalls.find((c) => c.method === "setMyName");
			assert.ok(setMyNameCall, "Expected setMyName API call during spin-up");
			assert.equal(setMyNameCall.body.name, "Pi • Demo Project");

			// Verify isolated config file was written
			const childConfigRaw = await readFile(spinRes.agent.configPath, "utf8");
			const childConfig = JSON.parse(childConfigRaw) as Record<string, unknown>;
			assert.equal(childConfig.botUsername, "pi_pool_1_bot");
			assert.equal(childConfig.displayName, "Pi • Demo Project");
			assert.equal(childConfig.allowedUserId, 999888777);
			assert.equal(childConfig.autoConnect, true);

			// Verify tmux session is actually alive
			const aliveAfterSpin = await hasTmuxSession("pi-demo-project");
			assert.equal(aliveAfterSpin, true);

			// 3. Rename bot on the fly via orchestrator.renameBot
			apiCalls.length = 0;
			const renameRes = await orchestrator.renameBot({
				target: "demo-project",
				newDisplayName: "Pi • Demo v2",
				shortDescription: "Updated description",
			});
			assert.equal(renameRes.bot.currentName, "Pi • Demo v2");
			assert.equal(apiCalls.some((c) => c.method === "setMyName" && c.body.name === "Pi • Demo v2"), true);
			assert.equal(
				apiCalls.some(
					(c) => c.method === "setMyShortDescription" && c.body.short_description === "Updated description",
				),
				true,
			);

			// 4. Simulate a crash (kill the tmux session behind the scenes) and test durable reconciliation
			await killTmuxSession("pi-demo-project");
			assert.equal(await hasTmuxSession("pi-demo-project"), false);

			const reconcileReport = await orchestrator.reconcileAgents({ autoRecover: true });
			assert.deepEqual(reconcileReport.recovered, ["demo-project"]);
			assert.equal(await hasTmuxSession("pi-demo-project"), true);

			// 5. Stop the agent and verify bot returns to pool and resets its display name
			apiCalls.length = 0;
			const stopRes = await orchestrator.stopAgent("demo-project", { resetBotDisplayName: true });
			assert.equal(stopRes.tmuxKilled, true);
			assert.equal(stopRes.bot?.status, "available");
			assert.equal(stopRes.bot?.assignedAgentName, null);
			assert.equal(stopRes.botRenamedTo, "Pi [Livre 1]");
			assert.equal(await hasTmuxSession("pi-demo-project"), false);

			// Verify audit trail has durable entries
			const audits = store.listRecentAudit(20);
			assert.ok(audits.length >= 5);
		} finally {
			if (prevPiBin === undefined) {
				delete process.env.PI_BINARY;
			} else {
				process.env.PI_BINARY = prevPiBin;
			}
			await killTmuxSession("pi-demo-project").catch(() => undefined);
			store.close();
		}
	});
});
