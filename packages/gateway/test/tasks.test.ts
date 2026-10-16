import type { ChatEntry } from "@pppi/protocol";
import { describe, expect, it } from "vitest";
import { entryWithArtifacts, extractTasks, parseTaskInfo } from "../src/artifacts.ts";

const TASK = (attrs: string) => `\`\`\`pppi-task ${attrs}\n\`\`\``;

describe("task fence extraction (#15)", () => {
	it("peels a valid task out of the text", () => {
		const { text, tasks } = extractTasks(
			`On it.\n\n${TASK('id=deploy title="Deploy v1.2" status=queued')}\n\nAnswering now.`,
		);
		expect(tasks).toEqual([{ id: "deploy", title: "Deploy v1.2", status: "queued" }]);
		expect(text).toBe("On it.\n\nAnswering now.");
	});

	it("attrs: quoted/bare values, detail, status default running", () => {
		expect(parseTaskInfo(' id=a title="Ship it" status=done detail="PR #31 merged"')).toMatchObject({
			id: "a",
			title: "Ship it",
			status: "done",
			detail: "PR #31 merged",
			valid: true,
		});
		expect(parseTaskInfo(" id=a").status).toBe("running");
		expect(parseTaskInfo(' title="no id"').valid).toBe(false);
		expect(parseTaskInfo(" id=a status=cancelled").valid).toBe(false); // unknown status degrades
	});

	it("unknown status / missing id / stray body stay as plain code (#28 tolerance)", () => {
		for (const bad of [TASK("id=a status=cancelled"), TASK('title="no id"'), "```pppi-task id=a\nstray body\n```"]) {
			const r = extractTasks(`x\n\n${bad}\n\ny`);
			expect(r.tasks).toHaveLength(0);
			expect(r.text).toContain("pppi-task");
		}
	});

	it("multiple updates in one reply: latest order kept, all attached", () => {
		const r = extractTasks(`${TASK("id=a status=queued")}\n${TASK("id=b title=B status=running")}`);
		expect(r.tasks.map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("lives alongside artifacts without interference", () => {
		const src = `Intro.\n\n\`\`\`pppi-artifact title="R"\n<p>r</p>\n\`\`\`\n\n${TASK("id=t status=running")}`;
		const entry = entryWithArtifacts({ id: "m", role: "assistant", text: src, ts: 0 } as ChatEntry);
		expect(entry.text).toBe("Intro.");
		expect(entry.artifacts?.[0]?.title).toBe("R");
		expect(entry.tasks?.[0]).toMatchObject({ id: "t", status: "running" });
	});

	it("entryWithArtifacts seeds tasks on history entries (reconnect resume)", () => {
		const entry = entryWithArtifacts({
			id: "m",
			role: "assistant",
			text: `done\n\n${TASK('id=z status=done detail="merged"')}`,
			ts: 0,
		} as ChatEntry);
		expect(entry.tasks?.[0]).toEqual({ id: "z", title: "z", status: "done", detail: "merged" });
	});
});
