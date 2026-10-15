import type { Artifact } from "@pppi/protocol";
// single source of truth: the QA fixture is also what gateway tests extract
import demoHtml from "../../../docs/fixtures/demo-artifact.html?raw";

/**
 * One-tap QA artifact (#17): open the client with ?demo-artifact and a demo
 * message with this artifact appears locally — no agent or gateway changes
 * needed to eyeball the card + sandboxed viewer.
 */
export const DEMO_ARTIFACT: Artifact = {
	id: "art-demo-fleet-status",
	title: "Fleet status (demo)",
	kind: "html",
	content: demoHtml.trim(),
};

/** the same artifact as an agent-emitted fence — used by gateway tests */
export const DEMO_ARTIFACT_FENCE = `\`\`\`pppi-artifact title="Fleet status (demo)"\n${DEMO_ARTIFACT.content}\n\`\`\``;
