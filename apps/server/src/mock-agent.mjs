// Mock pi RPC agent for tests: speaks the subset of pi's RPC protocol that
// apps/server/src/agent.ts relies on, without any LLM. Usage:
//   MOCK_REPLY="hello world" node mock-agent.mjs
// Also demonstrates the strict JSONL framing (split on \n only, strip \r).

import { StringDecoder } from "node:string_decoder";

const reply = process.env.MOCK_REPLY ?? "mock ok";
let lines = [];

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
	model: { provider: "mock", id: "mock-1", name: "Mock 1" },
	thinkingLevel: "off",
	isStreaming: false,
	sessionFile: "/tmp/mock-session.jsonl",
	sessionId: "mock-session-0000",
	sessionName: "omni",
	messageCount: 0,
	pendingMessageCount: 0,
};

function write(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

const history = [];

function handle(cmd) {
	switch (cmd.type) {
		case "get_state":
			write({ id: cmd.id, type: "response", command: "get_state", success: true, data: state });
			break;
		case "get_messages":
			write({ id: cmd.id, type: "response", command: "get_messages", success: true, data: { messages: history } });
			break;
		case "abort":
			write({ id: cmd.id, type: "response", command: "abort", success: true });
			break;
		case "prompt": {
			history.push({ role: "user", content: cmd.message, timestamp: Date.now() });
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
			const assistant = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
			write({ type: "message_end", message: assistant });
			history.push(assistant);
			write({ type: "agent_end", messages: [assistant], willRetry: false });
			write({ type: "agent_settled" });
			break;
		}
		default:
			write({ id: cmd.id, type: "response", command: String(cmd.type ?? "unknown"), success: false, error: "mock: unsupported" });
	}
}
