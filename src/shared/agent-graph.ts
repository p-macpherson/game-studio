// Where each agent type sits in the delegation graph's picture: a column per depth (the longest chain of
// delegation that reaches it), ordered within a column to keep a type near the ones that delegate to it.
export interface GraphNode {
	id: string;
	col: number;
	/** Position down its column, in rows; fractional, as shorter columns are centred on the tallest. */
	row: number;
}
export interface AgentGraph {
	nodes: GraphNode[];
	edges: { from: string; to: string }[];
	cols: number;
	rows: number;
}

export function layoutAgentGraph(types: { id: string; name: string; delegatesTo?: string[] }[]): AgentGraph {
	const byId = new Map(types.map((t) => [t.id, t]));
	const edges = types.flatMap((t) => (t.delegatesTo ?? []).filter((to) => byId.has(to) && to !== t.id).map((to) => ({ from: t.id, to })));
	const parents = new Map<string, string[]>(types.map((t) => [t.id, []]));
	for (const e of edges) parents.get(e.to)!.push(e.from);
	const depth = new Map<string, number>();
	const depthOf = (id: string, above: Set<string>): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		if (above.has(id)) return 0; // a loop (checkDelegation removes them): don't follow it
		above.add(id);
		const d = Math.max(-1, ...parents.get(id)!.map((p) => depthOf(p, above))) + 1;
		above.delete(id);
		depth.set(id, d);
		return d;
	};
	for (const t of types) depthOf(t.id, new Set());
	const cols = Math.max(0, ...depth.values()) + (types.length ? 1 : 0);
	const columns: string[][] = Array.from({ length: cols }, () => []);
	for (const t of types) columns[depth.get(t.id)!].push(t.id);
	const rows = Math.max(0, ...columns.map((c) => c.length));
	const row = new Map<string, number>();
	const name = (id: string) => byId.get(id)!.name;
	const delegates = (id: string) => (byId.get(id)!.delegatesTo ?? []).length > 0;
	columns.forEach((ids, col) => {
		// First column: the types that delegate, then the ones outside the graph. Later ones: by where their parents are.
		const key = (id: string) => (col === 0 ? (delegates(id) ? 0 : 1) : parents.get(id)!.reduce((sum, p) => sum + row.get(p)!, 0) / parents.get(id)!.length);
		ids.sort((a, b) => key(a) - key(b) || name(a).localeCompare(name(b)));
		ids.forEach((id, i) => row.set(id, (rows - ids.length) / 2 + i));
	});
	return { nodes: types.map((t) => ({ id: t.id, col: depth.get(t.id)!, row: row.get(t.id)! })), edges, cols, rows };
}
