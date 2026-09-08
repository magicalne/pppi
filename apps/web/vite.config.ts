import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	// relative so the same bundle works from the gateway root AND GitHub Pages (/pppi/)
	base: "./",
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": "http://127.0.0.1:8787",
			"/ws": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
	build: {
		outDir: "dist",
	},
});
