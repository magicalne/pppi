// The five pppi themes (docs/design/ui-prd.md §8). ids map to [data-theme] in tokens.css.

export type ThemeId = "dusk" | "dawn" | "slate" | "paper" | "matcha";

export const THEMES: { id: ThemeId; name: string; mood: string }[] = [
	{ id: "dusk", name: "Dusk", mood: "lamplight" },
	{ id: "dawn", name: "Dawn", mood: "morning paper" },
	{ id: "slate", name: "Slate", mood: "cool focus" },
	{ id: "paper", name: "Paper", mood: "pen & ink" },
	{ id: "matcha", name: "Matcha", mood: "greenhouse" },
];

const KEY = "pppi.theme";

export function loadTheme(): ThemeId {
	const saved = localStorage.getItem(KEY) as ThemeId | null;
	if (saved && THEMES.some((t) => t.id === saved)) return saved;
	return "dusk";
}

export function applyTheme(id: ThemeId) {
	document.documentElement.dataset.theme = id;
	localStorage.setItem(KEY, id);
}
