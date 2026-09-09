// Live soundwave above the composer while interactive mode is on — the web
// twin of Android's VoiceWave. Pure canvas on requestAnimationFrame; levels
// arrive via props, sampled into a trailing window ~10×/s, with a slow idle
// ripple so the wave breathes through silence and thinking.

import { useEffect, useRef } from "react";
import type { VoicePhase } from "./useVoice.ts";

const BARS = 28;
const SAMPLE_MS = 100;

export function VoiceWave({ inLevel, outLevel, phase }: { inLevel: number; outLevel: number; phase: VoicePhase }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const latest = useRef({ inLevel, outLevel, phase });
	latest.current = { inLevel, outLevel, phase };

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const hist = new Array<number>(BARS).fill(0);
		let raf = 0;
		let lastSample = 0;
		let lastAccent = "";
		let lastDim = "";
		let cssPoll = 0;

		const size = () => {
			const dpr = window.devicePixelRatio || 1;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
				canvas.width = Math.round(w * dpr);
				canvas.height = Math.round(h * dpr);
			}
			return { w, h, dpr };
		};

		const render = (t: number) => {
			raf = requestAnimationFrame(render);
			if (t - lastSample >= SAMPLE_MS) {
				lastSample = t;
				hist.shift();
				hist.push(latest.current.phase === "agent-speaking" ? latest.current.outLevel : latest.current.inLevel);
			}
			const { w, h, dpr } = size();
			if (t - cssPoll > 1000) {
				cssPoll = t;
				const css = getComputedStyle(canvas);
				lastAccent = css.getPropertyValue("--accent").trim();
				lastDim = css.getPropertyValue("--dim").trim();
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			const color = latest.current.phase === "thinking" ? lastDim || "#9a8f83" : lastAccent || "#e8965a";
			const slot = w / BARS;
			for (let i = 0; i < BARS; i++) {
				const lv = Math.sqrt((hist[i] ?? 0) / 100);
				const idle = 0.13 + 0.07 * Math.sin(t / 450 + i * 0.55);
				const bh = h * Math.min(1, Math.max(idle, lv));
				ctx.globalAlpha = 0.4 + 0.6 * (bh / h);
				ctx.fillStyle = color;
				const x = i * slot + slot * 0.25;
				const y = (h - bh) / 2;
				const bw = slot * 0.5;
				if (typeof ctx.roundRect === "function") {
					ctx.beginPath();
					ctx.roundRect(x, y, bw, bh, bw / 2);
					ctx.fill();
				} else {
					ctx.fillRect(x, y, bw, bh);
				}
			}
			ctx.globalAlpha = 1;
		};
		raf = requestAnimationFrame(render);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<canvas
			ref={canvasRef}
			style={{ width: "100%", height: 42, display: "block", padding: "0 18px", boxSizing: "border-box" }}
			aria-hidden
		/>
	);
}
