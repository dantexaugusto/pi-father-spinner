#!/usr/bin/env -S node --experimental-strip-types
/**
 * Generates infra/ansible/inventory.ini and infra/ansible/group_vars/all.yml
 * from infra/terraform.tfvars and infra/terraform.tfstate so `make ansible-deploy`
 * can run anytime via SSH without requiring an active AWS SSO session.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");
const INFRA_DIR = resolve(ROOT_DIR, "infra");
const ANSIBLE_DIR = resolve(INFRA_DIR, "ansible");

function extractTfvarString(content: string, key: string, fallback = ""): string {
	const regex = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
	const m = content.match(regex);
	return m ? m[1] : fallback;
}

function getLocalGitConfig(key: string): string {
	try {
		return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

async function main() {
	const tfvarsRaw = await readFile(resolve(INFRA_DIR, "terraform.tfvars"), "utf8");
	const tfstateRaw = await readFile(resolve(INFRA_DIR, "terraform.tfstate"), "utf8");
	const tfstate = JSON.parse(tfstateRaw) as {
		outputs?: Record<string, { value?: string }>;
	};

	const staticIp = tfstate.outputs?.static_public_ip?.value;
	if (!staticIp) {
		throw new Error(
			"Could not find static_public_ip in infra/terraform.tfstate. Run `make infra-apply` first.",
		);
	}
	const sshKeyPath = resolve(INFRA_DIR, "keys", "pi-father-spinner.pem");

	const awsRegion = extractTfvarString(tfvarsRaw, "aws_region", "us-east-1");
	const fatherBotToken = extractTfvarString(tfvarsRaw, "father_bot_token");
	const allowedUserId = extractTfvarString(tfvarsRaw, "allowed_telegram_user_id");
	const defaultProvider = extractTfvarString(tfvarsRaw, "default_provider", "amazon-bedrock");
	const defaultModel = extractTfvarString(tfvarsRaw, "default_model", "deepseek.v3.2");
	const defaultThinkingLevel = extractTfvarString(tfvarsRaw, "default_thinking_level", "high");
	const bedrockToken = extractTfvarString(tfvarsRaw, "AWS_BEARER_TOKEN_BEDROCK");
	const tavilyApiKey =
		extractTfvarString(tfvarsRaw, "tavily_api_key") || extractTfvarString(tfvarsRaw, "TAVILY_API_KEY");
	const gitUserName = extractTfvarString(tfvarsRaw, "git_user_name") || getLocalGitConfig("user.name");
	const gitUserEmail = extractTfvarString(tfvarsRaw, "git_user_email") || getLocalGitConfig("user.email");

	const idRsaContent = await readFile(resolve(homedir(), ".ssh", "id_rsa"), "utf8").catch(() => "");
	const idPubContent = await readFile(resolve(homedir(), ".ssh", "id_rsa.pub"), "utf8").catch(() => "");

	const inventoryContent = `[pi_father]\n${staticIp} ansible_user=ubuntu ansible_ssh_private_key_file=${sshKeyPath}\n`;

	const llmEnvLines: string[] = [];
	if (bedrockToken) {
		llmEnvLines.push(`AWS_BEARER_TOKEN_BEDROCK=${JSON.stringify(bedrockToken)}`);
	}
	llmEnvLines.push(`AWS_REGION=${JSON.stringify(awsRegion)}`);
	if (tavilyApiKey) {
		llmEnvLines.push(`TAVILY_API_KEY=${JSON.stringify(tavilyApiKey)}`);
	}

	const groupVarsObj = {
		pi_version: "0.80.2",
		git_user_name: gitUserName,
		git_user_email: gitUserEmail,
		father_bot_token: fatherBotToken,
		allowed_telegram_user_id: allowedUserId,
		pi_settings_json: {
			defaultProvider,
			defaultModel,
			defaultThinkingLevel,
			theme: "light",
			hideThinkingBlock: true,
		},
		pi_models_json: {
			providers: {
				"amazon-bedrock": {
					baseUrl: `https://bedrock-runtime.${awsRegion}.amazonaws.com`,
					api: "bedrock-converse-stream",
					models: [
						{
							id: "us.moonshotai.kimi-k3",
							name: "US Moonshot AI Kimi K3",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 262144,
							maxTokens: 32768,
							cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
						},
						{
							id: "global.moonshotai.kimi-k3",
							name: "Global Moonshot AI Kimi K3",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 262144,
							maxTokens: 32768,
							cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
						},
					],
				},
			},
		},
		bot_pool_json: { bots: [] },
		llm_env_content: `${llmEnvLines.join("\n")}\n`,
		local_git_id_rsa_content: idRsaContent,
		local_git_id_pub_content: idPubContent,
	};

	await mkdir(resolve(ANSIBLE_DIR, "group_vars"), { recursive: true });
	await writeFile(resolve(ANSIBLE_DIR, "inventory.ini"), inventoryContent, { mode: 0o600 });
	// Valid JSON is valid YAML 1.2 and parsed natively by Ansible group_vars
	await writeFile(
		resolve(ANSIBLE_DIR, "group_vars", "all.yml"),
		`${JSON.stringify(groupVarsObj, null, 2)}\n`,
		{ mode: 0o600 },
	);

	console.log(`[ansible] Generated inventory.ini (${staticIp}) and group_vars/all.yml`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
