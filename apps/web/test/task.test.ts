import type { TaskUpdate } from "@pppi/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskCard, liveTask } from "../src/Task.tsx";

describe("task card (#15 client)", () => {
	it("renders each status with its glyph and line", () => {
		for (const [status, line] of [
			["queued", "queued — starting soon"],
			["running", "running…"],
			["done", "done — result below/in the conversation"],
			["failed", "failed — see the reply for why"],
		] as const) {
			const html = renderToStaticMarkup(
				createElement(TaskCard, { task: { id: "t", title: "Deploy v1.2", status } as TaskUpdate }),
			);
			expect(html).toContain(`task-card ${status}`);
			expect(html).toContain("Deploy v1.2");
			expect(html).toContain(line);
		}
	});

	it("detail overrides the default status line", () => {
		const html = renderToStaticMarkup(
			createElement(TaskCard, { task: { id: "t", title: "Deploy", status: "done", detail: "PR #31 merged" } }),
		);
		expect(html).toContain("PR #31 merged");
		expect(html).not.toContain("done — result below");
	});

	it("live registry wins over the entry-time snapshot", () => {
		const snap: TaskUpdate = { id: "t", title: "Deploy", status: "running" };
		expect(liveTask(snap, { t: { id: "t", title: "Deploy", status: "done", detail: "merged" } }).status).toBe("done");
		expect(liveTask(snap, {}).status).toBe("running"); // no live update → snapshot
	});

	it("unknown statuses degrade to the queued glyph, never crash", () => {
		const html = renderToStaticMarkup(
			createElement(TaskCard, { task: { id: "t", title: "X", status: "weird" as never } }),
		);
		expect(html).toContain("task-card weird");
	});
});
