// The Design Docs section: the standard docs first, each with its status (set here by the user), rendered as
// markdown, editable by hand (Edit: an undo step in the selected worktree) or with the Game Designer.
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { studioFile } from "../../renderer/api";
import { DOC_STATUSES, type DocStatus, STATUS_LABEL, missingDocs, parseDoc, setDocBody, standardDoc } from "../../shared/design-docs";
import type { AssetSummary, ModuleInfo } from "../../shared/modules";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { Markdown } from "../../renderer/views/Markdown";
import { runInWorktree } from "../../renderer/workspace";

/** Resolves a relative link from one repo-relative file to another (`../Lore.md` from `docs/design/x/A.md`). */
export function resolveLink(from: string, href: string): string {
	const parts = from.split("/").slice(0, -1);
	for (const seg of href.split("#")[0].split("/")) {
		if (seg === "..") parts.pop();
		else if (seg && seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

const briefFirst = (docs: AssetSummary[]) => docs.find((d) => standardDoc(d.path)?.id === "game-brief") ?? docs.find((d) => /overview\.md$/i.test(d.path)) ?? docs[0];

const STATUS_NOTE: Record<DocStatus, string> = {
	"not-established": "Not decided yet. Agents follow the “For now” guidance below and keep this side of their work simple.",
	draft: "A draft: agents follow it, but expect it to change.",
	established: "Established: agents follow it.",
};

export function StatusDot({ status }: { status?: string }) {
	const s = DOC_STATUSES.find((x) => x === status);
	return s ? <i className={`doc-dot doc-${s}`} title={STATUS_LABEL[s]} /> : null;
}

export function DesignDocsView({ module }: { module: ModuleInfo }) {
	const showError = useStudio((s) => s.showError);
	/** The doc being edited by hand (its path). */
	const [editing, setEditing] = useState<string | null>(null);
	const run = (label: string, method: "set_doc_status" | "write_doc" | "add_standard_docs", params: Record<string, unknown>) =>
		runInWorktree(label, method, params).then(
			// The section reads the doc again (the worktree's files aren't watched).
			() => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 })),
			(err) => showError(err),
		);
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New doc"
			newPreset={{
				agentType: module.agentType,
				target: "project",
				context: `New ${module.noun} in ${module.roots[0]}/`,
				placeholder: "What should the new design doc cover?",
			}}
			modifyLabel="Discuss / modify"
			modifyPlaceholder="What do you want to discuss or change?"
			emptyText="No design docs yet. Start one with “New doc”."
			pickDefault={briefFirst}
			itemPreview={(a) => <StatusDot status={a.status} />}
			itemHint={(a) => STATUS_LABEL[a.status as DocStatus]}
			actions={(asset) =>
				asset.change === "deleted" ? null : (
					<>
						<select
							value={asset.status ?? ""}
							title="How settled this doc is: agents are told, and treat it accordingly"
							data-testid="doc-status"
							onChange={(e) => void run(`Docs: ${asset.title}`, "set_doc_status", { path: asset.path, status: e.target.value })}
						>
							{!asset.status && <option value="">No status</option>}
							{DOC_STATUSES.map((s) => (
								<option key={s} value={s}>
									{STATUS_LABEL[s]}
								</option>
							))}
						</select>
						<button onClick={() => setEditing(editing === asset.path ? null : asset.path)} data-testid="doc-edit">
							{editing === asset.path ? "Cancel edit" : "Edit"}
						</button>
					</>
				)
			}
			content={(p) => (
				<DocContent
					{...p}
					module={module}
					editing={editing === p.asset.path}
					onSave={async (text) => {
						await run(`Docs: ${p.asset.title}`, "write_doc", { path: p.asset.path, text });
						setEditing(null);
					}}
					onAddStandard={() => void run("Standard design docs", "add_standard_docs", {})}
				/>
			)}
		/>
	);
}

/** A picked, pasted or dropped image file as the add_doc_image request takes it. */
async function imageParams(f: File): Promise<{ name: string; data: string }> {
	const bytes = new Uint8Array(await f.arrayBuffer());
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return { name: f.name || "pasted.png", data: btoa(bin) };
}

function DocContent({
	asset,
	text,
	assets,
	checkout,
	module,
	editing,
	onSave,
	onAddStandard,
}: AssetContentProps & { module: ModuleInfo; editing: boolean; onSave(text: string): Promise<void>; onAddStandard(): void }) {
	const showAsset = useStudio((s) => s.showAsset);
	const openNewSession = useStudio((s) => s.openNewSession);
	const showError = useStudio((s) => s.showError);
	const picker = useRef<HTMLInputElement>(null);
	const source = useRef<HTMLTextAreaElement>(null);
	const imageSrc = useCallback((src: string) => studioFile(checkout, resolveLink(asset.path, src)), [checkout, asset.path]);
	/** Adds reference images (an undo step in the worktree); appended to the References section, or returned to insert. */
	const addImages = async (files: File[], insert: boolean, caption = ""): Promise<string[]> => {
		const out: string[] = [];
		for (const f of files.filter((x) => x.type.startsWith("image/"))) {
			try {
				const { result } = await runInWorktree(`Docs: ${asset.title}`, "add_doc_image", { path: asset.path, ...(await imageParams(f)), caption, insert });
				out.push((result as { markdown: string }).markdown);
			} catch (err) {
				showError(err);
			}
		}
		useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
		return out;
	};
	/** Picked images wait for a caption: what they're a reference for. */
	const [pending, setPending] = useState<File[] | null>(null);
	const [caption, setCaption] = useState("");
	/** Pasted or dropped images while editing go in at the cursor. */
	const insertImages = async (e: ClipboardEvent | DragEvent, files: FileList | undefined) => {
		const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (!list.length) return;
		e.preventDefault();
		const at = source.current?.selectionStart ?? draft.length;
		const md = await addImages(list, false);
		if (md.length) setDraft((d) => `${d.slice(0, at)}${md.join("\n")}${d.slice(at)}`);
	};
	const { status, body } = parseDoc(text);
	const [draft, setDraft] = useState(body);
	// Editing starts from the doc as it is now.
	useEffect(() => {
		if (editing) setDraft(body);
		// biome-ignore lint/correctness/useExhaustiveDependencies: only when editing starts or another doc is shown
	}, [editing, asset.path]);
	const missing = missingDocs(assets.filter((a) => a.change !== "deleted").map((a) => a.path));
	const def = standardDoc(asset.path);
	const together = () =>
		openNewSession({
			agentType: module.agentType,
			target: "project",
			linkedAsset: asset.path,
			context: `About ${asset.path}`,
			placeholder: "What do you already know you want? (or just start)",
			prompt: `Let's work out the ${asset.title} doc together. Interview me about it one topic at a time, and write up what we agree as we go.`,
		});
	if (editing) {
		return (
			<div className="doc-view col doc-editing">
				<div className="row">
					<span className="muted small grow">Markdown. The status is set from the header. Paste or drop images to add references. Ctrl+S saves.</span>
					<button className="primary" disabled={draft === body} onClick={() => void onSave(setDocBody(text, draft))} data-testid="doc-save">
						Save
					</button>
				</div>
				<textarea
					ref={source}
					className="doc-source"
					value={draft}
					onPaste={(e) => void insertImages(e, e.clipboardData.files)}
					onDrop={(e) => void insertImages(e, e.dataTransfer.files)}
					autoFocus
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key === "s") {
							e.preventDefault();
							if (draft !== body) void onSave(setDocBody(text, draft));
						}
					}}
					data-testid="doc-source"
				/>
			</div>
		);
	}
	return (
		<div className="doc-view">
			{missing.length > 0 && (
				<div className="doc-banner row" data-testid="docs-missing">
					<span className="grow">
						This project lacks {missing.length === 1 ? "a standard design doc" : `${missing.length} of the standard design docs`}: {missing.map((d) => d.title).join(", ")}.
						Agents are briefed from them.
					</span>
					<button onClick={onAddStandard} data-testid="docs-add-standard">
						Add {missing.length === 1 ? "it" : "them"}
					</button>
				</div>
			)}
			{status && (
				<div className={`doc-banner row doc-${status}`} data-testid="doc-banner">
					<StatusDot status={status} />
					<span className="grow">{STATUS_NOTE[status]}</span>
					{status !== "established" && (
						<button className={status === "not-established" ? "primary" : ""} onClick={together} data-testid="doc-together">
							{def ? "Work it out with the Game Designer" : "Work on it with the Game Designer"}
						</button>
					)}
				</div>
			)}
			<div className="row doc-tools">
				<span className="grow" />
				<input
					ref={picker}
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					multiple
					hidden
					data-testid="doc-image-input"
					onChange={(e) => {
						const files = [...(e.target.files ?? [])];
						e.target.value = "";
						if (files.length) {
							setCaption("");
							setPending(files);
						}
					}}
				/>
				<button className="ghost small" title="Add images of the look you want: saved in docs/design/references/, shown here and to agents" onClick={() => picker.current?.click()} data-testid="doc-add-image">
					+ Add reference image
				</button>
			</div>
			{pending && (
				<div className="row doc-caption" data-testid="doc-image-caption">
					<span className="small">
						{pending.length === 1 ? pending[0].name : `${pending.length} images`}: what {pending.length === 1 ? "is it" : "are they"} a reference for?
					</span>
					<input
						className="grow"
						autoFocus
						value={caption}
						placeholder="e.g. palette and lighting, how chunky the props are"
						onChange={(e) => setCaption(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								setPending(null);
								void addImages(pending, true, caption);
							}
							if (e.key === "Escape") setPending(null);
						}}
					/>
					<button className="primary" onClick={() => (setPending(null), void addImages(pending, true, caption))} data-testid="doc-image-add">
						Add
					</button>
					<button onClick={() => setPending(null)}>Cancel</button>
				</div>
			)}
			<Markdown
				text={body}
				imageSrc={imageSrc}
				onLink={(href) => {
					const target = resolveLink(asset.path, href);
					if (assets.some((d) => d.path === target)) showAsset({ path: target });
				}}
			/>
		</div>
	);
}
