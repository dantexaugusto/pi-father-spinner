/**
 * Tavily Web Search & URL Extraction Extension for Pi Coding Agent
 *
 * Provides native `tavily_search` (Web Search) and `tavily_extract` (URL Content Extraction)
 * tools to Pi-Father and all spun child Pi agents.
 *
 * Reads `TAVILY_API_KEY` from environment variables or dynamically from `~/.pi/agent/.env`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

interface TavilySearchResultItem {
	title: string;
	url: string;
	content: string;
	raw_content?: string;
	score?: number;
	published_date?: string;
}

interface TavilySearchResponse {
	query: string;
	answer?: string;
	results: TavilySearchResultItem[];
	response_time?: number;
}

interface TavilyExtractResultItem {
	url: string;
	raw_content: string;
}

interface TavilyExtractResponse {
	results: TavilyExtractResultItem[];
	failed_results?: Array<{ url: string; error: string }>;
	response_time?: number;
}

export function resolveTavilyApiKey(): string | undefined {
	const fromEnv = process.env.TAVILY_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	// Fallback: parse ~/.pi/agent/.env dynamically so keys added after agent startup work immediately
	try {
		const envPath = join(homedir(), ".pi", "agent", ".env");
		const content = readFileSync(envPath, "utf8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = line.match(/^(?:export\s+)?TAVILY_API_KEY\s*=\s*(.+)$/);
			if (match) {
				let val = match[1].trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (val) {
					process.env.TAVILY_API_KEY = val;
					return val;
				}
			}
		}
	} catch {
		// ignore
	}

	return undefined;
}

export default function tavilyExtension(pi: ExtensionAPI) {
	// ─── 1. Tool: tavily_search (Web Search) ───────────────────────────────────
	pi.registerTool({
		name: "tavily_search",
		label: "Tavily Web Search",
		description:
			"Search the live web using Tavily AI Search API. Returns an AI-synthesized answer and ranked web results with snippets and URLs. Use this whenever you need up-to-date documentation, libraries, news, or web research.",
		promptSnippet: "Search the web in real time using Tavily (tavily_search).",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to look up on the web",
			}),
			searchDepth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description: "Search depth: 'basic' (fast, 1 credit) or 'advanced' (deep research, 2 credits). Default: 'basic'",
				}),
			),
			topic: Type.Optional(
				Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")], {
					description: "Search category/topic. Default: 'general'",
				}),
			),
			maxResults: Type.Optional(
				Type.Number({
					description: "Maximum number of search results to return (1 to 20, default: 5)",
					minimum: 1,
					maximum: 20,
				}),
			),
			includeAnswer: Type.Optional(
				Type.Boolean({
					description: "Include a concise AI-generated summary answer from Tavily (default: true)",
				}),
			),
			includeRawContent: Type.Optional(
				Type.Boolean({
					description: "Include full parsed page content for each result (default: false)",
				}),
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional list of domains to restrict search results to (e.g. ['github.com', 'docs.aws.amazon.com'])",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional list of domains to exclude from search results",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const apiKey = resolveTavilyApiKey();
			if (!apiKey) {
				throw new Error(
					"TAVILY_API_KEY is not configured. Add tavily_api_key in infra/terraform.tfvars (or ~/.pi/agent/.env) and run make ansible-deploy.",
				);
			}

			const body: Record<string, unknown> = {
				api_key: apiKey,
				query: params.query,
				search_depth: params.searchDepth ?? "basic",
				topic: params.topic ?? "general",
				max_results: params.maxResults ?? 5,
				include_answer: params.includeAnswer ?? true,
				include_raw_content: params.includeRawContent ?? false,
			};

			if (params.includeDomains && params.includeDomains.length > 0) {
				body.include_domains = params.includeDomains;
			}
			if (params.excludeDomains && params.excludeDomains.length > 0) {
				body.exclude_domains = params.excludeDomains;
			}

			const res = await fetch(TAVILY_SEARCH_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`Tavily Search API error (HTTP ${res.status}): ${errText || res.statusText}`);
			}

			const data = (await res.json()) as TavilySearchResponse;
			const lines: string[] = [`### Tavily Web Search: "${data.query}"`];

			if (data.answer) {
				lines.push("", "**Summary Answer:**", data.answer);
			}

			if (!data.results || data.results.length === 0) {
				lines.push("", "_No results found._");
			} else {
				lines.push("", `**Results (${data.results.length}):**`);
				for (const [idx, item] of data.results.entries()) {
					lines.push(
						"",
						`${idx + 1}. **[${item.title || item.url}](${item.url})**${
							item.published_date ? ` _(${item.published_date})_` : ""
						}`,
						`   ${item.content}`,
					);
					if (params.includeRawContent && item.raw_content) {
						const snippet =
							item.raw_content.length > 4000
								? `${item.raw_content.slice(0, 4000)}\n...[truncated]`
								: item.raw_content;
						lines.push(`   <raw_content>\n${snippet}\n   </raw_content>`);
					}
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query: data.query,
					resultCount: data.results?.length ?? 0,
					responseTime: data.response_time,
				},
			};
		},
	});

	// ─── 2. Tool: tavily_extract (Web Page Content Extractor) ──────────────────
	pi.registerTool({
		name: "tavily_extract",
		label: "Tavily URL Extract",
		description:
			"Extract clean markdown/text content from one or more web page URLs using the Tavily Extract API.",
		promptSnippet: "Extract full readable content from web URLs using Tavily (tavily_extract).",
		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				description: "List of 1 to 10 URLs to extract clean content from",
				minItems: 1,
				maxItems: 10,
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const apiKey = resolveTavilyApiKey();
			if (!apiKey) {
				throw new Error(
					"TAVILY_API_KEY is not configured. Add tavily_api_key in infra/terraform.tfvars (or ~/.pi/agent/.env) and run make ansible-deploy.",
				);
			}

			const res = await fetch(TAVILY_EXTRACT_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					api_key: apiKey,
					urls: params.urls,
				}),
				signal,
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`Tavily Extract API error (HTTP ${res.status}): ${errText || res.statusText}`);
			}

			const data = (await res.json()) as TavilyExtractResponse;
			const lines: string[] = [`### Tavily Extracted URLs (${data.results?.length ?? 0})`];

			for (const item of data.results ?? []) {
				const text =
					item.raw_content.length > 12000
						? `${item.raw_content.slice(0, 12000)}\n...[truncated]`
						: item.raw_content;
				lines.push("", `#### ${item.url}`, text);
			}

			if (data.failed_results && data.failed_results.length > 0) {
				lines.push("", "**Failed URLs:**");
				for (const fail of data.failed_results) {
					lines.push(`- ${fail.url}: ${fail.error}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					extractedCount: data.results?.length ?? 0,
					failedCount: data.failed_results?.length ?? 0,
				},
			};
		},
	});

	// ─── 3. Slash Command: /tavily-status ──────────────────────────────────────
	pi.registerCommand("tavily-status", {
		description: "Check whether Tavily Web Search API key is configured",
		handler: async (_args, ctx) => {
			const key = resolveTavilyApiKey();
			if (key) {
				const masked = key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : "configured";
				ctx.ui.notify(`Tavily Web Search is ENABLED (key: ${masked})`, "info");
			} else {
				ctx.ui.notify("Tavily Web Search is NOT configured (missing TAVILY_API_KEY)", "warning");
			}
		},
	});
}
