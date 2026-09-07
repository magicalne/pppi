// Status bar (docs/plan/status-bar.md): context usage, model, thinking effort.
// The brain is a press-hold + swipe slider whose brightness IS the level; the
// model name opens the enabled-models sheet. Mirrors pi's canonical ladder.

import type { AgentStatus, ModelInfo } from "@pppi/protocol";
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

// Lucide "brain" (ISC license) — stroke paths in the 24-unit viewBox
const BRAIN_PATHS = [
	"M12 18V5",
	"M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
	"M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
	"M17.997 5.125a4 4 0 0 1 2.526 5.77",
	"M18 18a4 4 0 0 0 2-7.464",
	"M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
	"M6 18a4 4 0 0 1-2-7.464",
	"M6.003 5.125a4 4 0 0 0-2.526 5.77",
];

function BrainIcon({ level }: { level: string }) {
	const alpha = FILL_ALPHA[level] ?? 0;
	// dim base strokes = "off"; accent strokes fade in with the level and
	// carry a drop-shadow bloom — the shadow mask inherits the stroke alpha,
	// so the glow scales with the level for free (no light at "off")
	const layer = (
		stroke: string,
		opacity: number | undefined,
		transition: string | undefined,
		extra?: React.CSSProperties,
	) => (
		<g
			fill="none"
			stroke={stroke}
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ strokeOpacity: opacity, transition, ...extra }}
		>
			{BRAIN_PATHS.map((d) => (
				<path key={d} d={d} />
			))}
		</g>
	);
	return (
		<svg viewBox="0 0 24 24" width={19} height={19} aria-hidden focusable="false" style={{ overflow: "visible" }}>
			<title>thinking effort</title>
			{layer("var(--dim)", 1, undefined)}
			{layer("var(--accent)", alpha, "stroke-opacity 120ms ease", {
				filter: alpha > 0 ? "drop-shadow(0 0 2px var(--accent)) drop-shadow(0 0 6px var(--accent))" : undefined,
			})}
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

	// commit what the user last saw under their finger — never the raw up
	// position (the brain sits left of the track, so a tap's x would clamp to
	// stop 0 = "off"; a tap has no moves, so preview is still curIdx → no-op)
	const onBrainUp = () => {
		if (!sliding) return;
		setSliding(false);
		if (preview !== curIdx) stepTo(preview);
	};

	const onBrainCancel = () => {
		if (sliding) setSliding(false);
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
	const aura = FILL_ALPHA[stops[shownIdx] ?? level] ?? 0;

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
				style={{ "--aura": aura } as React.CSSProperties}
				onPointerDown={onBrainDown}
				onPointerMove={onBrainMove}
				onPointerUp={onBrainUp}
				onPointerCancel={onBrainCancel}
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
