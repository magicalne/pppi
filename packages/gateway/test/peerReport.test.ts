import type { AgentState } from "@pppi/protocol";
import { describe, expect, it } from "vitest";
import { reportPreview, shouldPeerReport } from "../src/peerReport.ts";

describe("peer report policy (#13)", () => {
	it("reports while no turn is active (idle, waiting, starting)", () => {
		for (const s of ["idle", "waiting", "starting"] as AgentState[]) expect(shouldPeerReport(s)).toBe(true);
	});

	it("stays quiet while a turn is active — the conversation carries it", () => {
		for (const s of ["thinking", "tool", "streaming", "compacting"] as AgentState[]) {
			expect(shouldPeerReport(s)).toBe(false);
		}
	});

	it("preview = first non-empty line, trimmed, capped at 90", () => {
		expect(reportPreview("Issue #42 created.\n\nhttps://github.com/x")).toBe("Issue #42 created.");
		expect(reportPreview("\n\n   done — see PR #7  \nmore")).toBe("done — see PR #7");
		expect(reportPreview("x".repeat(200))).toHaveLength(90);
		expect(reportPreview("")).toBeNull();
		expect(reportPreview("\n \n\t\n")).toBeNull();
	});
});
