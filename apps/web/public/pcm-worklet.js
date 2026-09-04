// AudioWorklet: batches input frames into ~4096-sample buffers and ships them
// to the main thread. Plain JS on purpose — it loads via audioWorklet.addModule
// straight from /public, outside the bundler.
class PcmCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.chunks = [];
		this.length = 0;
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (channel && channel.length) {
			this.chunks.push(new Float32Array(channel));
			this.length += channel.length;
			if (this.length >= 4096) {
				const merged = new Float32Array(this.length);
				let offset = 0;
				for (const c of this.chunks) {
					merged.set(c, offset);
					offset += c.length;
				}
				this.chunks = [];
				this.length = 0;
				this.port.postMessage(merged, [merged.buffer]);
			}
		}
		return true;
	}
}
registerProcessor("pcm-capture", PcmCapture);
