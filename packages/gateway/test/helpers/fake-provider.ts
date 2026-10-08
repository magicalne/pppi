// Scripted fake pi-ai provider for durable-driver tests: a static catalog model
// whose streams replay scripted deltas. Hermetic — no credentials, no network.
//
// Hard-won details (see docs/plan/durable-omni-pilot.md "Context"):
// - `Usage` must be COMPLETE (`totalTokens`, `cost.{input,output,cacheRead,
//   cacheWrite,total}`) — pi-durable's addUsage sums every counter and a
//   missing one writes NaN into the pi.usage document.

import {
	type ApiKeyAuth,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthResult,
	type Model,
	type Provider,
	type TranscriptContext,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export const FAKE_API = "pppi-test-api" as const;

export const FAKE_MODEL: Model<typeof FAKE_API> = {
	id: "fake-1",
	name: "Fake 1",
	api: FAKE_API,
	provider: "pppi-test",
	baseUrl: "http://fake.invalid",
	input: ["text"],
	reasoning: true,
	thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
};

const FULL_USAGE = {
	input: 3,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A scripted provider. Every call streams the same reply; `gate` (when set) holds every `done` until it resolves. */
export class FakeProvider implements Provider<typeof FAKE_API> {
	readonly id = "pppi-test";
	readonly name = "pppi test";
	/** Arguments of `stream()` per call, for asserting steer/followUp delivery. */
	readonly calls: Array<{ messages: unknown[]; options: unknown }> = [];
	private currentReply = "ack from the durable omni";

	readonly auth: { apiKey: ApiKeyAuth } = {
		apiKey: {
			name: "pppi test key",
			resolve: async (): Promise<AuthResult | undefined> => ({
				auth: { type: "bearer", key: "test" } as never,
				source: "fake",
			}),
		},
	};

	/** Change the reply every following call streams (tests script multi-turn conversations). */
	reply(text: string): void {
		this.currentReply = text;
	}

	getModels(): readonly (typeof FAKE_MODEL)[] {
		return [FAKE_MODEL];
	}

	/** While set, every stream's `done` event waits for this promise to resolve (kill-mid-turn tests). */
	gate: Promise<void> | null = null;

	stream(model: typeof FAKE_MODEL, context: TranscriptContext): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		this.calls.push({ messages: context.messages as unknown[], options: context });
		const text = this.currentReply;
		const final: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...FULL_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const partial: AssistantMessage = { ...final, content: [] };
		const push = (...events: AssistantMessageEvent[]) => {
			for (const e of events) stream.push(e);
		};
		const half = text.slice(0, Math.ceil(text.length / 2));
		// Space the deltas well past pi-durable's 100ms progress-commit interval:
		// each delta becomes its own committed partial (and its own message_update),
		// the way a real network-paced provider streams. The done event waits behind
		// any gate so kill-mid-turn tests own the timing.
		const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
		at(5, () => push({ type: "start", partial }, { type: "text_start", contentIndex: 0, partial }));
		at(20, () =>
			push({
				type: "text_delta",
				contentIndex: 0,
				delta: half,
				partial: { ...partial, content: [{ type: "text", text: half }] },
			}),
		);
		at(170, () =>
			push(
				{
					type: "text_delta",
					contentIndex: 0,
					delta: text.slice(Math.ceil(text.length / 2)),
					partial: final,
				},
				{ type: "text_end", contentIndex: 0, content: text, partial: final },
			),
		);
		at(320, async () => {
			if (this.gate) await this.gate;
			stream.push({ type: "done", reason: "stop", message: final });
		});
		return stream;
	}

	streamSimple(model: typeof FAKE_MODEL, context: TranscriptContext): AssistantMessageEventStream {
		return this.stream(model, context);
	}
}
