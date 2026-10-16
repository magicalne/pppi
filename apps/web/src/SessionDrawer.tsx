// The sessions drawer (#45): repos, pi sessions and worktree sessions as
// targets — rows wear their profile color (the same identity reply
// attribution uses), state stays readable, and section headers tint with the
// repo's main-session color.

import type { Profile, SessionsResponse } from "@pppi/protocol";
import { dotStateClass, sectionTint, sessionDotColor } from "./drawer.ts";

/** The conversation target: a session id (undefined = the omni itself). */
export type Target = { id: string | undefined; label: string };

export const OMNI = (): Target => ({ id: undefined, label: "Omni" });

export function SessionDrawer(props: {
	sessions: SessionsResponse | null;
	/** profiles by session id — the same map reply attribution colors bubbles with */
	profiles?: Record<string, Profile>;
	target: Target;
	onPick: (t: Target) => void;
	onUnpair: () => void;
}) {
	const { sessions, target, profiles } = props;
	const stateLabel = (state: string) =>
		state === "busy" ? "working…" : state === "unreachable" ? "unreachable" : "idle";
	// #45: the row dot wears the session's profile color (attribution twin);
	// state stays readable as the dot's modifier + the textual label
	const peerRow = (label: string, id: string, state: string, depth: number): React.ReactNode => {
		const dot = sessionDotColor(profiles?.[id]);
		return (
			<button
				type="button"
				key={id}
				className={`srow ${target.id === id ? "active" : ""}`}
				onClick={() => props.onPick({ id, label })}
			>
				{Array.from({ length: depth }, (_, i) => i).map((v) => (
					<span key={`guide-${v}`} className="guide" aria-hidden />
				))}
				<span
					className={`ring ${dotStateClass(state)}`}
					style={dot ? { background: dot, borderColor: dot } : undefined}
				/>
				<span className="sname">{label}</span>
				<span className="sstate">{stateLabel(state)}</span>
			</button>
		);
	};
	const omniDot = sessionDotColor(sessions ? profiles?.[sessions.omniSessionId] : undefined);

	return (
		<div className="drawer" onClick={(e) => e.stopPropagation()}>
			<h3>Sessions</h3>
			<button type="button" className={`srow ${!target.id ? "active" : ""}`} onClick={() => props.onPick(OMNI())}>
				<span className="ring" style={omniDot ? { background: omniDot, borderColor: omniDot } : undefined} />
				<span className="sname">Omni</span>
				<span className="sstate">the whole fleet</span>
			</button>

			{(sessions?.projects ?? []).map((p) => {
				const mains = p.sessions.filter((s) => !s.worktree);
				const wts = p.sessions.filter((s) => s.worktree);
				// section header wears the repo's main-session profile color (#45)
				const mainDot = sessionDotColor(profiles?.[mains[0]?.sessionId ?? ""]);
				return (
					<div key={p.name}>
						<div className="shead" style={mainDot ? sectionTint(mainDot) : undefined}>
							<span className="shead-dot" style={mainDot ? { background: mainDot } : undefined} />
							{p.name}
						</div>
						{mains.length === 0 && (
							<div className="srow empty-row">
								<span className="guide" aria-hidden />
								<span className="sname">no open session</span>
							</div>
						)}
						{mains.map((s) => peerRow(s.name ?? `#${s.sessionId.slice(0, 4)}`, s.sessionId, s.state, 1))}
						{wts.map((s) => peerRow(s.worktree ?? "", s.sessionId, s.state, 2))}
					</div>
				);
			})}
			{(sessions?.others ?? []).map((s) => peerRow(s.name ?? `#${s.sessionId.slice(0, 4)}`, s.sessionId, s.state, 1))}

			<div className="sep" />
			<div className="footer">
				<button type="button" className="unpair" onClick={props.onUnpair}>
					Unpair this device
				</button>
			</div>
		</div>
	);
}
