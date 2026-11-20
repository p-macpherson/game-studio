// Settings → Appearance: the colour theme and the fonts, applied as soon as they're picked (appearance.ts).
import { useState } from "react";
import { type Appearance, FONTS, type Font, loadAppearance, MONO_FONTS, saveAppearance, THEMES, type Theme } from "../appearance";

export function AppearanceSettings() {
	const [a, setA] = useState<Appearance>(loadAppearance);
	const set = (next: Partial<Appearance>) => {
		const merged = { ...a, ...next };
		saveAppearance(merged);
		setA(merged);
	};
	const families = [...new Set(THEMES.map((t) => t.family))];
	return (
		<div className="col appearance" style={{ gap: 18 }}>
			<section className="col" style={{ gap: 8 }}>
				<h3>Theme</h3>
				{families.map((f) => (
					<div key={f} className="col" style={{ gap: 6 }}>
						<span className="muted small">{f}</span>
						<div className="theme-grid">
							{THEMES.filter((t) => t.family === f).map((t) => (
								<ThemeCard key={t.id} theme={t} on={a.theme === t.id} onPick={() => set({ theme: t.id })} />
							))}
						</div>
					</div>
				))}
			</section>
			<FontPicker title="Interface font" fonts={FONTS} value={a.font} sample="The goblin opens the chest" onPick={(font) => set({ font })} testid="font" />
			<FontPicker title="Code font" fonts={MONO_FONTS} value={a.mono} sample={'engine.play_sound("gold.ogg") // 0O 1lI'} onPick={(mono) => set({ mono })} testid="mono" />
		</div>
	);
}

/** A small picture of the studio in the theme's own colours (not the current theme's). */
function ThemeCard({ theme, on, onPick }: { theme: Theme; on: boolean; onPick(): void }) {
	const c = theme.colors;
	return (
		<button className={`theme-card ${on ? "on" : ""}`} onClick={onPick} aria-pressed={on} data-testid="theme-card" data-theme-id={theme.id} title={`${theme.family} ${theme.name}`}>
			<div className="theme-preview" style={{ background: c.bg, borderColor: c.border }}>
				<div className="theme-preview-side" style={{ background: c.panel, borderColor: c.border }}>
					<span style={{ background: c.accent }} />
					<span style={{ background: c.muted }} />
					<span style={{ background: c.muted }} />
				</div>
				<div className="theme-preview-main">
					<span style={{ background: c.text, width: "70%" }} />
					<span style={{ background: c.muted, width: "90%" }} />
					<div className="theme-preview-dots">
						{[c.green, c.yellow, c.red, c.purple, c.blue].map((d, i) => (
							<i key={i} style={{ background: d }} />
						))}
					</div>
					<span className="theme-preview-button" style={{ background: c.accent2, color: c.onAccent }}>
						Aa
					</span>
				</div>
			</div>
			<span className="theme-name">{theme.name}</span>
		</button>
	);
}

function FontPicker(p: { title: string; fonts: Font[]; value: string; sample: string; onPick(id: string): void; testid: string }) {
	return (
		<section className="col" style={{ gap: 8 }}>
			<h3>{p.title}</h3>
			<div className="font-list">
				{p.fonts.map((f) => (
					<button key={f.id} className={`font-option ${p.value === f.id ? "on" : ""}`} aria-pressed={p.value === f.id} onClick={() => p.onPick(f.id)} data-testid={`${p.testid}-option`}>
						<span className="font-name" style={{ fontFamily: f.family }}>
							{f.name}
						</span>
						<span className="muted small ellipsis" style={{ fontFamily: f.family }}>
							{p.sample}
						</span>
					</button>
				))}
			</div>
		</section>
	);
}
