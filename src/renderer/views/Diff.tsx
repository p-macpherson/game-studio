export function Diff({ text }: { text: string }) {
	if (!text.trim()) return <div className="empty">No changes.</div>;
	return (
		<pre className="diff">
			{text.split("\n").map((line, i) => {
				const cls = line.startsWith("diff --git")
					? "meta"
					: line.startsWith("@@")
						? "hunk"
						: line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "del"
								: undefined;
				return (
					<div key={i} className={cls}>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}
