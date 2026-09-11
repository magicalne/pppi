// Prototype bench: sherpa-onnx (native) running kokoro-int8 with its streaming
// generateAsync callback — the candidate replacement for kokoro-js. Run:
//   SHERPA_KOKORO_DIR=/tmp/kokoro-int8-en-v0_19 bun packages/gateway/test/bench-sherpa-tts.ts
import { join } from "node:path";

const dir = process.env.SHERPA_KOKORO_DIR!;
const { createRequire } = await import("node:module");
const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as any;

const config = {
	model: {
		kokoro: {
			model: join(dir, "model.int8.onnx"),
			voices: join(dir, "voices.bin"),
			tokens: join(dir, "tokens.txt"),
			dataDir: join(dir, "espeak-ng-data"),
			lengthScale: 1.0,
		},
	},
	numThreads: 4,
	sampleRate: 24000,
	debug: false,
	provider: "cpu",
};

const t0 = performance.now();
const tts = new sherpa.OfflineTts(config);
console.log(`engine load (cold): ${(performance.now() - t0).toFixed(0)}ms`);

const sentence = "The build finished and all of the unit tests passed on the first attempt.";

for (let i = 0; i < 3; i++) {
	const chunks: Array<{ samples: number; at: number }> = [];
	const t1 = performance.now();
	const audio = await tts.generateAsync({
		text: sentence,
		sid: 8, // af_heart is index 8 in voices.bin
		speed: 1.0,
		onProgress: ({ samples }: { samples: Float32Array }) => {
			chunks.push({ samples: samples.length, at: performance.now() - t1 });
		},
	});
	const first = chunks[0]?.at ?? -1;
	const totalMs = performance.now() - t1;
	const audioMs = (audio.samples.length / audio.sampleRate) * 1000;
	console.log(
		`run ${i + 1}: first chunk after ${first.toFixed(0)}ms (${chunks.length} chunks), done in ${totalMs.toFixed(0)}ms, audio ${audioMs.toFixed(0)}ms → RTF ${(totalMs / audioMs).toFixed(3)}x`,
	);
}

// long text: does first-chunk stay fast as text grows?
const paragraph =
	"The build finished about ten minutes ago and everything looks healthy so far. " +
	"The unit tests all passed on the first attempt, which honestly does not happen very often. " +
	"Deployment is currently in progress and should reach production within the next few minutes.";
{
	const chunks: number[] = [];
	const t1 = performance.now();
	const audio = await tts.generateAsync({
		text: paragraph,
		sid: 8,
		speed: 1.0,
		onProgress: ({ samples: s }: { samples: Float32Array }) => chunks.push(performance.now() - t1),
	});
	const audioMs = (audio.samples.length / audio.sampleRate) * 1000;
	console.log(
		`paragraph: first chunk after ${chunks[0]!.toFixed(0)}ms, ${chunks.length} chunks, RTF ${((performance.now() - t1) / audioMs).toFixed(3)}x`,
	);
}
