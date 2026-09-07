// @pppi/gateway — the pppi gateway core: HTTP+WS transport, wire-protocol
// mapping, voice stack, and the RPC agent driver. Hosted today by the
// standalone cli (apps/server); hosted inside a pi session by the pppi
// extension's /omni command.

export {
	type AgentPort,
	type AgentSnapshot,
	type AgentState,
	RpcAgentDriver,
	toolLabel,
} from "./agent.ts";
export { loadOrCreateConfig, pppiDir, tokensMatch, type ServerConfig } from "./config.ts";
export { buildPairInfo, lanIps, writePairFile } from "./pair.ts";
export { createGateway, type Gateway, type GatewayOptions } from "./gateway.ts";
export { Stt } from "./stt.ts";
export { resolveTtsProvider } from "./tts.ts";
