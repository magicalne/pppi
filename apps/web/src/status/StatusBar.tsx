// Status bar (docs/plan/status-bar.md): context usage, model, thinking effort.
// The brain is a press-hold + swipe slider whose brightness IS the level; the
// model name opens the enabled-models sheet. Mirrors pi's canonical ladder.

import type { AgentStatus, ModelInfo } from "@sspi/protocol";
import { useRef, useState } from "react";

/** pi's canonical thinking ladder (pi-agent-core ThinkingLevel). */
const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Brightness of the brain per level — dim at off, fully lit at max. */
const FILL_ALPHA: Record<string, number> = {
	off: 0,
	minimal: 0.25,
	low: 0.4,
	medium: 0.55,
	high: 0.7,
	xhigh: 0.85,
	max: 1,
};

const TICK_LABEL: Record<string, string> = { minimal: "min", medium: "med" };

export function formatTokens(n: number | null): string {
	if (n === null) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
	const m = n / 1_000_000;
	return `${m >= 10 || m % 1 === 0 ? Math.round(m) : m.toFixed(1)}m`;
}

// one brain hemisphere; rendered twice (right one mirrored) for the two-lobe glyph
const LOBE =
	"M11.4 20.9 C9 20.9 7 19.2 6.6 16.9 A4.8 4.8 0 0 1 4.3 11.7 A4.8 4.8 0 0 1 5.6 5.9 A4.1 4.1 0 0 1 11.4 4.6 Z";

function BrainIcon({ level }: { level: string }) {
	const alpha = FILL_ALPHA[level] ?? 0;
	return (
		<svg viewBox="0 0 24 24" width={19} height={19} aria-hidden focusable="false">
			<title>thinking effort</title>
			<g fill="none" stroke="var(--dim)" strokeWidth={1.3} strokeLinejoin="round">
				<path d={LOBE} />
				<path d={LOBE} transform="matrix(-1 0 0 1 24 0)" />
			</g>
			<g fill="var(--accent)" stroke="none" style={{ fillOpacity: alpha, transition: "fill-opacity 120ms ease" }}>
				<path d={LOBE} />
				<path d={LOBE} transform="matrix(-1 0 0 1 24 0)" />
			</g>
		</svg>
	);
}

export function StatusBar(props: {
	status: AgentStatus | null;
	models: ModelInfo[];
	/** omni target selected — controls only ever drive the omni session */
	active: boolean;
	/** peer label shown in the model slot when not active */
	targetLabel: string;
	send: (msg: Record<string, unknown>) => void;
	notify: (message: string) => void;
}) {
	const { status, active } = props;
	const [sheetOpen, setSheetOpen] = useState(false);
	const [sliding, setSliding] = useState(false);
	const [preview, setPreview] = useState(0);
	const [linger, setLinger] = useState<string | null>(null);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const stops = status?.thinkingLevels ?? [];
	const level = status?.thinkingLevel ?? "off";
	const curIdx = Math.max(0, stops.indexOf(level));
	const noThinking = !status?.model || (!status.model.reasoning && stops.length <= 1);
	const brainDisabled = !active || noThinking;

	const showChip = (text: string) => {
		setLinger(text);
		if (lingerTimer.current) clearTimeout(lingerTimer.current);
		lingerTimer.current = setTimeout(() => setLinger(null), 1200);
	};

	const chipText = (lvl: string) => {
		const native = status?.model?.thinkingLevelMap?.[lvl];
		return native && native !== lvl ? `${lvl} · ${native}` : lvl;
	};

	const stepTo = (idx: number) => {
		const next = Math.min(Math.max(idx, 0), stops.length - 1);
		if (next === curIdx || !stops[next]) return;
		props.send({ type: "set_thinking_level", level: stops[next] });
		showChip(chipText(stops[next]!));
	};

	const stopFromX = (clientX: number): number => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0 || stops.length < 2) return preview;
		const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
		return Math.round((x / rect.width) * (stops.length - 1));
	};

	const onBrainDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (brainDisabled) {
			if (active)
				props.notify(
					noThinking
						? status?.model
							? "this model doesn't do thinking"
							: "no model yet"
						: `switch model in ${props.targetLabel} itself`,
				);
			return;
		}
		// touch pointers implicitly capture; explicit capture is a mouse enhancement
		// and must never break the gesture (synthetic/inactive pointer ids throw)
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// drag still works via events on the element itself
		}
		setSliding(true);
		setPreview(curIdx);
	};

	const onBrainMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!sliding) return;
		setPreview(stopFromX(e.clientX));
	};

	const onBrainUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!sliding) return;
		const idx = stopFromX(e.clientX);
		setSliding(false);
		if (e.type !== "pointercancel" && idx !== curIdx) stepTo(idx); // a plain tap commits nothing (anti-footgun)
	};

	const onBrainKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (brainDisabled || stops.length < 2) return;
		if (e.key === "ArrowRight" || e.key === "ArrowUp") stepTo(curIdx + 1);
		else if (e.key === "ArrowLeft" || e.key === "ArrowDown") stepTo(curIdx - 1);
		else if (e.key === "Home") stepTo(0);
		else if (e.key === "End") stepTo(stops.length - 1);
		else return;
		e.preventDefault();
	};

	const openModels = () => {
		if (!active) return;
		props.send({ type: "list_models" });
		setSheetOpen(true);
	};

	const pickModel = (m: ModelInfo) => {
		setSheetOpen(false);
		props.send({ type: "set_model", provider: m.provider, modelId: m.id });
	};

	const ctx = status?.context ?? null;
	// never show omni's context for a peer conversation — the bar describes
	// the agent that will answer (design §2 scope rule)
	const ctxText = !active
		? "—"
		: ctx
			? `${formatTokens(ctx.tokens)}/${formatTokens(ctx.contextWindow)} (${ctx.percent === null ? "—" : Math.round(ctx.percent)}%)`
			: "—";
	const ctxHot = active && (ctx?.percent ?? 0) >= 85;
	const shownIdx = sliding ? preview : curIdx;
	const frac = stops.length > 1 ? shownIdx / (stops.length - 1) : 0;
	const chipShown = sliding ? chipText(stops[shownIdx] ?? level) : linger;

	return (
		<div className="status-bar">
			<div
				role="slider"
				tabIndex={brainDisabled ? -1 : 0}
				aria-label="Thinking effort"
				aria-valuemin={0}
				aria-valuemax={Math.max(stops.length - 1, 0)}
				aria-valuenow={shownIdx}
				aria-valuetext={stops[shownIdx] ?? level}
				aria-disabled={brainDisabled || undefined}
				className={`brain ${brainDisabled ? "off" : ""}`}
				onPointerDown={onBrainDown}
				onPointerMove={onBrainMove}
				onPointerUp={onBrainUp}
				onPointerCancel={onBrainUp}
				onKeyDown={onBrainKey}
			>
				<BrainIcon level={sliding ? (stops[shownIdx] ?? level) : level} />
			</div>

			{sliding && stops.length > 1 ? (
				<div className="sthink" ref={trackRef}>
					<div className="sthink-rail" />
					<div className="sthink-fill" style={{ width: `${frac * 100}%` }} />
					<div className="sthink-thumb" style={{ left: `${frac * 100}%` }} />
					<div className="sthink-ticks" aria-hidden>
						{stops.map((s) => (
							<span key={s} className={LADDER.indexOf(s) <= LADDER.indexOf(stops[shownIdx] ?? "off") ? "on" : ""}>
								{TICK_LABEL[s] ?? s}
							</span>
						))}
					</div>
					{chipShown && (
						<div className="sthink-chip" style={{ left: `${Math.min(Math.max(frac, 0.12), 0.88) * 100}%` }}>
							{chipShown}
						</div>
					)}
				</div>
			) : (
				<span className={`ctx ${ctxHot ? "ctx-danger" : ""}`}>{ctxText}</span>
			)}

			<button type="button" className={`model ${active ? "" : "peer"}`} onClick={openModels} disabled={!active}>
				<span>{active ? (status?.model?.name ?? "—") : props.targetLabel}</span>
				{active && (
					<span className="chev" aria-hidden>
						›
					</span>
				)}
			</button>

			{sheetOpen && (
				<ModelSheet
					models={props.models}
					current={status?.model ?? null}
					onPick={pickModel}
					onClose={() => setSheetOpen(false)}
				/>
			)}
		</div>
	);
}

function ModelSheet(props: {
	models: ModelInfo[];
	current: ModelInfo | null;
	onPick: (m: ModelInfo) => void;
	onClose: () => void;
}) {
	const grouped = props.models.length > 6;
	const groups = new Map<string, ModelInfo[]>();
	for (const m of props.models) {
		const key = grouped ? m.provider : "";
		const list = groups.get(key) ?? [];
		list.push(m);
		groups.set(key, list);
	}
	return (
		<>
			<div className="backdrop" onClick={props.onClose} />
			<div className="sheet" onClick={(e) => e.stopPropagation()}>
				<h3>Model</h3>
				{props.models.length === 0 && <p className="conn-hint">no enabled models available</p>}
				{[...groups.entries()].map(([provider, list]) => (
					<div key={provider || "all"}>
						{grouped && <div className="mgroup">{provider}</div>}
						{list.map((m) => {
							const current = props.current?.provider === m.provider && props.current?.id === m.id;
							return (
								<button
									type="button"
									key={`${m.provider}/${m.id}`}
									className={`mrow ${current ? "active" : ""}`}
									onClick={() => props.onPick(m)}
								>
									<span className="mcheck" aria-hidden>
										{current ? "✓" : ""}
									</span>
									<span className="mname">{m.name}</span>
									<span className="msub">
										{m.provider} · {formatTokens(m.contextWindow)}
									</span>
								</button>
							);
						})}
					</div>
				))}
				<p className="conn-hint">from your pi enabled models</p>
			</div>
		</>
	);
}
