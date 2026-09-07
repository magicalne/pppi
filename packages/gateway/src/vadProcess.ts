// VAD host process: silero v5 ONNX in its own process.
//
// Why a process and not a worker thread: the gateway also runs kokoro TTS
// through transformers.js, and sharing native ONNX runtime state between the
// two stalls VAD inference permanently (observed as the window queue never
// draining once synthesis started). Separate processes have separate runtime
// state; the protocol is one JSON message per line over stdio:
//   → {"id":1,"type":"prob","pcm":[...512 floats...]}
//   ← {"id":1,"prob":0.97}
//   → {"type":"reset"}
//   ← {"type":"ready"}

import { createInterface } from "node:readline";
import * as ort from "onnxruntime-node";

const modelPath = process.argv[2] ?? process.env.PPPI_VAD_MODEL ?? "";
if (!modelPath) {
	console.error("vad-process: model path required");
	process.exit(1);
}

const session = await ort.InferenceSession.create(modelPath);
let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

const out = process.stdout;
const send = (msg: Record<string, unknown>): void => out.write(`${JSON.stringify(msg)}\n`);

send({ type: "ready" });

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	let msg: { id?: number; type: string; pcm?: number[] };
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type === "reset") {
		state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
		return;
	}
	if (msg.type === "prob" && Array.isArray(msg.pcm)) {
		const pcm = Float32Array.from(msg.pcm);
		const input = new ort.Tensor("float32", pcm, [1, pcm.length]);
		session
			.run({ input, state, sr })
			.then((res) => {
				state = res.stateN as ort.Tensor;
				send({ id: msg.id, prob: res.output.data[0] ?? 0 });
			})
			.catch(() => send({ id: msg.id, prob: 0 }));
	}
});
