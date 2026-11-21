// Voice Lines: a character's voice (a description in words) and the lines it speaks. Each line has its text and a
// direction; its takes are fresh performances to audition, each with how well its voice matches the character's
// other lines, and the chosen take is the file the game plays. voice.json is the asset; edits and generation run
// in the selected worktree.
import { useEffect, useMemo, useState } from "react";
import type { VoiceTakes } from "../../main/voices";
import type { StudioRequestMethod } from "../../shared/host";
import type { ModuleInfo } from "../../shared/modules";
import { isDrifted, LINE_ID, languageOf, lineFile, parseVoice, takeIsCurrent, type Voice, type VoiceLine } from "../../shared/voice";
import { call, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { runInWorktree } from "../../renderer/workspace";
import { type Player, usePlayer, Waveform } from "../sounds/view";
import { voiceName } from "./info";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));

export function VoicesView({ module }: { module: ModuleInfo }) {
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New voice"
			newPreset={{
				agentType: "voice-director",
				placeholder: "Who is speaking (age, accent, what the voice sounds like, their character), and the lines they need: the words, and how each is said.",
			}}
			modifyLabel="Ask the voice director"
			modifyPlaceholder="What should change? New lines, a different read of a line, another voice."
			emptyText="No voices yet. Start one with “New voice”: the Voice Director describes the voice and performs its lines for you to audition."
			content={(props) => <VoiceDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
		/>
	);
}

type Run = (label: string, method: StudioRequestMethod, params: Record<string, unknown>) => Promise<void>;

function VoiceDetail({ asset, text, checkout }: AssetContentProps) {
	const showError = useStudio((s) => s.showError);
	const name = voiceName(asset.path);
	const dir = `assets/voices/${name}`;
	const { voice, problems } = useMemo(() => parseVoice(text), [text]);
	const [takes, setTakes] = useState<VoiceTakes>({ records: {}, matches: {}, references: {}, rendered: {} });
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const player = usePlayer();
	const file = (path: string) => studioFile(checkout, `${dir}/${path}`, `${version}`);

	useEffect(() => {
		let live = true;
		call("voices.takes", checkout ?? null, name).then(
			(t) => live && setTakes(t),
			() => live && setTakes({ records: {}, matches: {}, references: {}, rendered: {} }),
		);
		return () => {
			live = false;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: the file's text and our own steps are what change them
	}, [name, checkout, text, version]);

	const run: Run = async (label, method, params) => {
		setBusy(label);
		try {
			await runInWorktree(`Voice: ${name}`, method, { name, ...params });
			bumpAssets();
			setVersion((v) => v + 1);
		} catch (err) {
			showError(err);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="sound-detail voice-detail" data-testid="voice-detail">
			{problems.length > 0 && (
				<div className="card music-problems" data-testid="voice-problems">
					<h3>Problems in voice.json</h3>
					{problems.map((p, i) => (
						<div key={i}>
							{p.at && <code>{p.at}</code>} {p.message}
						</div>
					))}
				</div>
			)}
			{voice && (
				<>
					<VoiceCard voice={voice} busy={busy} run={run} />
					{voice.lines.map((line) => (
						<LineCard key={line.id} voice={voice} line={line} takes={takes} busy={busy} run={run} player={player} file={file} />
					))}
					<AddLine voice={voice} busy={busy} run={run} />
				</>
			)}
		</div>
	);
}

function VoiceCard({ voice, busy, run }: { voice: Voice; busy: string | null; run: Run }) {
	const [description, setDescription] = useState(voice.voice);
	const [language, setLanguage] = useState(languageOf(voice));
	const changed = description.trim() !== voice.voice || language.trim() !== languageOf(voice);
	return (
		<div className="card col" data-testid="voice-card">
			<div className="row">
				<div className="grow col" style={{ gap: 2 }}>
					<h3>The voice</h3>
					<div className="muted small">Who is speaking, in words: age, accent, the sound of the voice, the character. Every take is performed from this plus the line's direction.</div>
				</div>
				<span className="muted small">{busy}</span>
			</div>
			{voice.notes && <div className="sound-notes">{voice.notes}</div>}
			<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="voice-description" />
			<div className="row">
				<label className="muted small">Language</label>
				<input value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: 140 }} />
				<span className="grow muted small">{changed && voice.lines.some((l) => l.take) ? "Changing the voice outdates every line's takes: generate them again after saving." : ""}</span>
				<button className="primary" disabled={!changed || !description.trim() || !!busy} onClick={() => void run("Saving…", "edit_voice", { set: { voice: description.trim(), language: language.trim() === "English" ? null : language.trim() } })} data-testid="voice-save">
					Save voice
				</button>
			</div>
		</div>
	);
}

function LineCard({ voice, line, takes, busy, run, player, file }: { voice: Voice; line: VoiceLine; takes: VoiceTakes; busy: string | null; run: Run; player: Player; file(path: string): string }) {
	const [text, setText] = useState(line.text);
	const [direction, setDirection] = useState(line.direction ?? "");
	const changed = text.trim() !== line.text || direction.trim() !== (line.direction ?? "");
	// This line's takes: the chosen one first, then by match (best first), then newest.
	const mine = Object.entries(takes.records)
		.filter(([, r]) => r.line === line.id)
		.map(([f, r]) => ({ id: f.replace(/\.wav$/, ""), record: r, match: takes.matches[f.replace(/\.wav$/, "")], current: takeIsCurrent(voice, line, r) }))
		.sort((a, b) => Number(b.id === line.take) - Number(a.id === line.take) || Number(b.current) - Number(a.current) || (b.match ?? 0) - (a.match ?? 0) || b.record.at.localeCompare(a.record.at));
	const chosen = mine.find((t) => t.id === line.take);
	const rendered = !!line.take && takes.rendered[line.id] === line.take;
	const references = takes.references[line.id] ?? 0;
	const state = !line.take ? "none" : !chosen?.current ? "outdated" : isDrifted(chosen.match, references) ? "drifted" : "ok";
	const generate = () => void run(`Performing “${line.id}”…`, "generate_voice", { line: line.id, text: text.trim(), direction: direction.trim(), count: 4 });
	return (
		<div className="card col voice-line" data-testid="voice-line" data-line={line.id} data-state={state}>
			<div className="row">
				<code className="grow">{lineFile(line.id)}</code>
				{state === "none" && <span className="muted small">No take yet</span>}
				{state === "outdated" && <span className="small warn" title="Its take was performed from an earlier text, direction or voice">Take is of an earlier version</span>}
				{state === "drifted" && <span className="small warn" title="The chosen take's voice measures a long way from the character's other lines: listen, and pick another take or perform it again">Voice may have drifted</span>}
				{rendered && (
					<button onClick={() => void player.toggle(file(lineFile(line.id)), { id: `line:${line.id}` })} data-testid="line-play" title="The file the game plays">
						{player.current === `line:${line.id}` ? "■ Stop" : "▶ Play"}
					</button>
				)}
			</div>
			<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="The words spoken" data-testid="line-text" />
			<input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="How it's said, e.g. “Dry, weary sarcasm, deadpan.”" data-testid="line-direction" />
			<div className="row">
				<span className="grow muted small">{changed ? "Edited: perform it again to hear the change." : ""}</span>
				{changed && (
					<button disabled={!text.trim() || !!busy} onClick={() => void run("Saving…", "edit_voice", { line: { id: line.id, text: text.trim(), direction: direction.trim() } })}>
						Save without performing
					</button>
				)}
				<button className="primary" disabled={!text.trim() || !!busy} onClick={generate} data-testid="line-generate" title="Four fresh performances of this line">
					{mine.length ? "↻ More takes" : "Perform"}
				</button>
				<button disabled={!!busy} onClick={() => window.confirm(`Remove the line “${line.id}” and its takes?`) && void run("Removing…", "edit_voice", { remove: line.id })} title="Remove this line and its takes">
					✕
				</button>
			</div>
			{mine.length > 0 && (
				<div className="col voice-takes" data-testid="voice-takes">
					{mine.map((t) => (
						<div key={t.id} className={`row voice-take ${t.id === line.take ? "chosen" : ""}`} data-testid="voice-take" data-take={t.id}>
							<button className="small" onClick={() => void player.toggle(file(`takes/${t.id}.wav`), { level: true, id: t.id })}>
								{player.current === t.id ? "■" : "▶"}
							</button>
							<Waveform url={file(`takes/${t.id}.wav`)} level />
							<span className={`small voice-match ${isDrifted(t.match, references) ? "warn" : "muted"}`} title="How close this take's voice measures to the character's other chosen lines (1 is identical). A rough guide for comparing this line's takes: a character's own takes mostly score 0.94-0.99, but so can another character's, and shouted lines score lower. Trust your ears." data-testid="take-match">
								{t.match === undefined ? "—" : t.match.toFixed(3)}
								{isDrifted(t.match, references) ? " drifted" : ""}
							</span>
							<span className="grow muted small ellipsis">{t.current ? "" : "earlier version"}</span>
							{t.id === line.take ? (
								<span className="small voice-chosen">✓ In the game</span>
							) : (
								<button className="small" disabled={!!busy} onClick={() => void run("Rendering…", "edit_voice", { line: { id: line.id, take: t.id } })} data-testid="take-use">
									Use this take
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function AddLine({ voice, busy, run }: { voice: Voice; busy: string | null; run: Run }) {
	const [id, setId] = useState("");
	const [text, setText] = useState("");
	const [direction, setDirection] = useState("");
	const problem = !id ? "" : !LINE_ID.test(id) ? "lower-kebab-case, e.g. greeting" : voice.lines.some((l) => l.id === id) ? "there is a line with this name" : "";
	const add = async () => {
		await run(`Performing “${id}”…`, "generate_voice", { line: id, text: text.trim(), direction: direction.trim(), count: 4 });
		setId("");
		setText("");
		setDirection("");
	};
	return (
		<div className="card col" data-testid="voice-add-line">
			<h3>Add a line</h3>
			<div className="row">
				<input value={id} onChange={(e) => setId(e.target.value)} placeholder="name (its file: greeting → greeting.ogg)" style={{ width: 280 }} data-testid="new-line-id" />
				<span className="grow small warn">{problem}</span>
			</div>
			<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="The words spoken" data-testid="new-line-text" />
			<input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="How it's said" data-testid="new-line-direction" />
			<div className="row">
				<span className="grow" />
				<button className="primary" disabled={!id || !!problem || !text.trim() || !!busy} onClick={() => void add()} data-testid="new-line-perform">
					Perform
				</button>
			</div>
		</div>
	);
}
