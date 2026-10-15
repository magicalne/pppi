import type { TaskUpdate } from "@pppi/protocol";

/**
 * Tasks — issue #15. Accepted background work renders as a live job card:
 * the message that announced the task carries the card (position preserved,
 * like artifact cards), and later `task` events update it IN PLACE through
 * the client's live-task registry — the card the user watched go "running"
 * flips to "done" without a new message. The chat lane stays interactive
 * throughout; the result lands in the conversation when it lands.
 */

const STATUS_GLYPH: Record<TaskUpdate["status"], string> = {
	queued: "○",
	running: "◐",
	done: "●",
	failed: "✕",
};

export function TaskCard({ task }: { task: TaskUpdate }) {
	return (
		<div className={`task-card ${task.status}`} aria-label={`Task ${task.title}: ${task.status}`}>
			<span className={`task-glyph ${task.status === "running" ? "spin" : ""}`} aria-hidden>
				{STATUS_GLYPH[task.status] ?? "○"}
			</span>
			<span className="task-meta">
				<span className="task-title">{task.title}</span>
				<span className="task-detail">
					{task.status === "queued" && (task.detail ?? "queued — starting soon")}
					{task.status === "running" && (task.detail ?? "running…")}
					{task.status === "done" && (task.detail ?? "done — result below/in the conversation")}
					{task.status === "failed" && (task.detail ?? "failed — see the reply for why")}
				</span>
			</span>
		</div>
	);
}

/** merge a live update over the entry-time snapshot; live wins */
export function liveTask(entryTask: TaskUpdate, live: Record<string, TaskUpdate>): TaskUpdate {
	return live[entryTask.id] ?? entryTask;
}
