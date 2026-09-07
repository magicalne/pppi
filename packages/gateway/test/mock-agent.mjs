// Mock pi RPC agent for tests: speaks the subset of pi's RPC protocol that
// apps/server/src/agent.ts relies on, without any LLM. Usage:
//   MOCK_REPLY="hello world" node mock-agent.mjs
// Also demonstrates the strict JSONL framing (split on \n only, strip \r).

import { StringDecoder } from "node:string_decoder";

const reply = process.env.MOCK_REPLY ?? "mock ok";
const _lines = [];

const dec = new StringDecoder("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
	buf += typeof chunk === "string" ? chunk : dec.write(chunk);
	for (;;) {
		const nl = buf.indexOf("\n");
		if (nl === -1) break;
		let line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));

const state = {
	model: {
		provider: "mock",
		id: "mock-1",
		name: "Mock 1",
		reasoning: true,
		contextWindow: 100_000,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" },
	},
	thinkingLevel: "low",
	isStreaming: false,
	sessionFile: "/tmp/mock-session.jsonl",
	sessionId: "mock-session-0000",
	sessionName: "omni",
	messageCount: 0,
	pendingMessageCount: 0,
};

const availableModels = [
	state.model,
	{ provider: "mock", id: "mock-2", name: "Mock 2", reasoning: false, contextWindow: 50_000, thinkingLevelMap: {} },
	{
		provider: "other",
		id: "other-1",
		name: "Other 1",
		reasoning: true,
		contextWindow: 200_000,
		thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
];

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// mirrors pi-ai getSupportedThinkingLevels
function supportedLevels(model) {
	if (!model.reasoning) return ["off"];
	return LEVEL_ORDER.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
		return true;
	});
}

// mirrors pi-ai clampThinkingLevel (nearest supported at-or-below, else lowest)
function clampLevel(model, level) {
	const levels = supportedLevels(model);
	if (levels.includes(level)) return level;
	const idx = LEVEL_ORDER.indexOf(level);
	for (let i = idx; i >= 0; i--) if (levels.includes(LEVEL_ORDER[i])) return LEVEL_ORDER[i];
	return levels[0] ?? "off";
}

function write(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const history = [];

// strictly-increasing fake clock: rapid prompts can land in the same
// Date.now() millisecond, which would break before-timestamp pagination
let clock = Date.now() - 10_000;
const nextTs = () => ++clock;

function handle(cmd) {
	switch (cmd.type) {
		case "get_state":
			write({ id: cmd.id, type: "response", command: "get_state", success: true, data: state });
			break;
		case "get_messages":
			write({ id: cmd.id, type: "response", command: "get_messages", success: true, data: { messages: history } });
			break;
		case "get_available_thinking_levels":
			write({
				id: cmd.id,
				type: "response",
				command: "get_available_thinking_levels",
				success: true,
				data: { levels: supportedLevels(state.model) },
			});
			break;
		case "get_session_stats":
			write({
				id: cmd.id,
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: {
						tokens: 1_000 + history.length * 100,
						contextWindow: state.model.contextWindow,
						percent: Math.round(((1_000 + history.length * 100) / state.model.contextWindow) * 1000) / 10,
					},
				},
			});
			break;
		case "get_available_models":
			write({
				id: cmd.id,
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: availableModels },
			});
			break;
		case "set_model": {
			const found = availableModels.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
			if (!found) {
				write({
					id: cmd.id,
					type: "response",
					command: "set_model",
					success: false,
					error: `Model not found: ${cmd.provider}/${cmd.modelId}`,
				});
				break;
			}
			state.model = found;
			state.thinkingLevel = clampLevel(found, state.thinkingLevel);
			write({ id: cmd.id, type: "response", command: "set_model", success: true, data: found });
			break;
		}
		case "set_thinking_level":
			state.thinkingLevel = clampLevel(state.model, cmd.level);
			write({ id: cmd.id, type: "response", command: "set_thinking_level", success: true });
			break;
		case "abort":
			write({ id: cmd.id, type: "response", command: "abort", success: true });
			break;
		case "prompt": {
			history.push({ role: "user", content: cmd.message, timestamp: nextTs() });
			write({ id: cmd.id, type: "response", command: "prompt", success: true });
			// simulate an agent turn: agent_start → deltas → message_end → agent_settled
			const text = reply.replace("{echo}", String(cmd.message).slice(0, 120));
			write({ type: "agent_start" });
			write({ type: "message_start", message: { role: "assistant", content: [] } });
			for (const part of text.match(/[\s\S]{1,7}/g) ?? []) {
				write({
					type: "message_update",
					usage: {},
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part },
				});
			}
			const assistant = {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
				timestamp: nextTs(),
			};
			write({ type: "message_end", message: assistant });
			history.push(assistant);
			write({ type: "agent_end", messages: [assistant], willRetry: false });
			write({ type: "agent_settled" });
			break;
		}
		default:
			write({
				id: cmd.id,
				type: "response",
				command: String(cmd.type ?? "unknown"),
				success: false,
				error: "mock: unsupported",
			});
	}
}
