// Play scenarios in the studio: reading one from a checkout, the form for its parameters (the values are remembered
// per scenario on this machine), and the picker Play & Test shows above its Run buttons.
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AssetSummary } from "../../shared/modules";
import { type Scenario, type ScenarioParam, type ScenarioValue, type ScenarioValues, parseScenario, resolveScenario, scenarioValues } from "../../shared/scenario";
import { call } from "../api";
import { savedScenarioValues, scenarioValuesKey, useStudio } from "../store";

/** A scenario's values for this project: what was last used where it still suits the file, else its defaults. */
export function useScenarioValues(scenario: Scenario | null, path: string | null): [ScenarioValues, (id: string, v: ScenarioValue) => void, () => void] {
	const project = useStudio((s) => s.project?.path);
	const [version, setVersion] = useState(0);
	const values = useMemo(() => (scenario && path ? scenarioValues(scenario, savedScenarioValues(project, path)) : {}), [scenario, path, project, version]);
	const set = (id: string, v: ScenarioValue) => {
		if (!path) return;
		localStorage.setItem(scenarioValuesKey(project, path), JSON.stringify({ ...values, [id]: v }));
		setVersion((n) => n + 1);
	};
	const reset = () => {
		if (path) localStorage.removeItem(scenarioValuesKey(project, path));
		setVersion((n) => n + 1);
	};
	return [values, set, reset];
}

/** Reads and parses a scenario file from a checkout (null while loading or when there's none). */
export function useScenario(checkout: string | null | undefined, path: string | null): { scenario: Scenario | null; problems: string[] } | null {
	const assetsVersion = useStudio((s) => s.assetsVersion);
	const [read, setRead] = useState<{ path: string; scenario: Scenario | null; problems: string[] } | null>(null);
	useEffect(() => {
		if (!path) return setRead(null);
		let live = true;
		call("assets.read", path, checkout ?? null).then(
			(text) => live && setRead({ path, ...parseScenario(text) }),
			(err) => live && setRead({ path, scenario: null, problems: [(err as Error).message] }),
		);
		return () => {
			live = false;
		};
	}, [checkout, path, assetsVersion]);
	return read && read.path === path ? read : null;
}

function Field({ p, value, onChange }: { p: ScenarioParam; value: ScenarioValue; onChange(v: ScenarioValue): void }) {
	const label = p.label ?? p.id;
	if (p.type === "toggle") {
		return (
			<label className="row scenario-field" title={p.help} data-testid="scenario-param" data-param={p.id}>
				<input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
				<span>{label}</span>
			</label>
		);
	}
	return (
		<label className="row scenario-field" title={p.help} data-testid="scenario-param" data-param={p.id}>
			<span className="muted">{label}</span>
			{p.type === "choice" ? (
				<select value={String(value)} onChange={(e) => onChange(e.target.value)}>
					{(p.options ?? []).map((o) => (
						<option key={o} value={o}>
							{o}
						</option>
					))}
				</select>
			) : p.type === "number" ? (
				<>
					<input type="number" value={Number(value)} min={p.min} max={p.max} step={p.step ?? 1} onChange={(e) => e.target.value !== "" && Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))} />
					{p.random && (
						<button
							className="small icon"
							title="Roll a new one"
							aria-label={`Roll a new ${label}`}
							onClick={() => {
								const lo = p.min ?? 0;
								const hi = p.max ?? 999_999;
								onChange(Math.floor(lo + Math.random() * (hi - lo + 1)));
							}}
							data-testid="scenario-roll"
						>
							🎲
						</button>
					)}
				</>
			) : (
				<input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
			)}
		</label>
	);
}

/** The controls for a scenario's parameters. */
export function ScenarioForm({ scenario, values, onChange }: { scenario: Scenario; values: ScenarioValues; onChange(id: string, v: ScenarioValue): void }) {
	if (!scenario.params?.length) return null;
	return (
		<div className="row scenario-form" data-testid="scenario-form">
			{scenario.params.map((p) => (
				<Field key={p.id} p={p} value={values[p.id]} onChange={(v) => onChange(p.id, v)} />
			))}
		</div>
	);
}

/** What starting the scenario with these values comes to: the game's extra arguments and the commands sent to it. */
export function ScenarioLaunchPreview({ scenario, values }: { scenario: Scenario; values: ScenarioValues }) {
	const launch = resolveScenario(scenario, values);
	if (!launch.args.length && !launch.setup.length) return <span className="muted small">Starts the game as it normally starts (no scene, flags or setup yet).</span>;
	return (
		<pre className="scenario-launch" data-testid="scenario-launch">
			{[launch.args.length ? `game ${launch.args.join(" ")}` : "", ...launch.setup.map((c) => `then  ${JSON.stringify({ cmd: c.cmd, ...c.args })}`)].filter(Boolean).join("\n")}
		</pre>
	);
}

/** Play & Test's scenario row: which scenario the Run buttons start (or the game from its start), and its parameters. */
export function ScenarioPicker() {
	const { playCheckout, playScenario, setPlayScenario, assetsVersion, showAsset } = useStudio(
		useShallow((s) => ({ playCheckout: s.playCheckout, playScenario: s.playScenario, setPlayScenario: s.setPlayScenario, assetsVersion: s.assetsVersion, showAsset: s.showAsset })),
	);
	const [list, setList] = useState<AssetSummary[]>([]);
	useEffect(() => {
		let live = true;
		call("assets.list", "scenarios", playCheckout).then((l) => live && setList(l.filter((a) => a.change !== "deleted")), () => live && setList([]));
		return () => {
			live = false;
		};
	}, [playCheckout, assetsVersion]);
	// A scenario this checkout doesn't have (another worktree's) isn't offered.
	const path = playScenario && list.some((a) => a.path === playScenario) ? playScenario : null;
	const read = useScenario(playCheckout, path);
	const [values, setValue] = useScenarioValues(read?.scenario ?? null, path);
	if (!list.length) return null;
	return (
		<div className="scenario-bar" data-testid="scenario-bar">
			<div className="row">
				<label className="row scenario-field">
					<span className="muted">Start as</span>
					<select value={path ?? ""} onChange={(e) => setPlayScenario(e.target.value || null)} data-testid="scenario-select">
						<option value="">The game, from its start</option>
						{list.map((a) => (
							<option key={a.path} value={a.path}>
								{a.title}
							</option>
						))}
					</select>
				</label>
				{read?.scenario && !read.problems.length && <ScenarioForm scenario={read.scenario} values={values} onChange={setValue} />}
				{path && (
					<button className="link small" onClick={() => showAsset({ path, checkout: playCheckout })} title="Open it in the Scenarios section">
						About this scenario ›
					</button>
				)}
			</div>
			{read && read.problems.length > 0 && <div className="msg error small">This scenario can't be played: {read.problems.join("; ")}</div>}
			{read?.scenario?.notes && !read.problems.length && <div className="muted small scenario-notes">{read.scenario.notes}</div>}
		</div>
	);
}
