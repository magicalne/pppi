import type { Profile } from "@pppi/protocol";

/**
 * #13: a delegated reply landed while the omni was idle — surface it as a
 * tappable notification instead of letting it drown in the chat. Tap jumps
 * to the reply. Name/color resolve from the client's profile cache; a
 * missing profile falls back to the #id-prefix (unnamed sessions).
 */
export function PeerReportToast(props: {
	profileId: string;
	preview: string;
	profiles: Record<string, Profile> | undefined;
	onTap: () => void;
}) {
	const prof = props.profiles?.[props.profileId];
	return (
		<button type="button" className="toast report" onClick={props.onTap}>
			<span className="report-dot" style={{ background: prof?.color ?? "var(--dim)" }} aria-hidden />
			<span className="report-body">
				<b>{prof?.name ?? `#${props.profileId.slice(0, 4)}`}</b> reported: {props.preview}
				<i>tap to view</i>
			</span>
		</button>
	);
}
