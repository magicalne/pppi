import type { Profile } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeerReportToast } from "../src/PeerReportToast.tsx";

const profiles: Record<string, Profile> = {
	s1: { id: "s1", name: "ppi-dev-1", color: "#e8b14a", description: "dev work" },
};

describe("peer report toast (#13 client)", () => {
	it("renders the agent name, preview and tap affordance", () => {
		const html = renderToStaticMarkup(
			createElement(PeerReportToast, { profileId: "s1", preview: "Issue #42 created.", profiles, onTap: () => {} }),
		);
		expect(html).toContain("ppi-dev-1");
		expect(html).toContain("Issue #42 created.");
		expect(html).toContain("tap to view");
		expect(html).toContain('style="background:#e8b14a"');
		expect(html).toContain("<button");
	});

	it("unknown profile falls back to the #id-prefix (no name garbage)", () => {
		const html = renderToStaticMarkup(
			createElement(PeerReportToast, {
				profileId: "0199abcd-1234",
				preview: "x",
				profiles: undefined,
				onTap: () => {},
			}),
		);
		expect(html).toContain("#0199");
	});
});
