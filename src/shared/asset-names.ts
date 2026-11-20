// Names of folder-shaped assets (models, sounds, music): the folder under the section's root, which may be nested
// ("props/barrel" is assets/models/props/barrel/). Files named after the asset use the last part (barrel.glb).

const PART = "[a-z0-9]+(-[a-z0-9]+)*";
/** lower-kebab-case parts, separated by "/" for folders. */
export const ASSET_NAME = new RegExp(`^${PART}(/${PART})*$`);

/** The last part of a name: what files inside the asset are named after. */
export const leafName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** A folder-shaped asset's name from its manifest's path: `assets/models/props/barrel/model.json` → `props/barrel`. */
export function nameFromPath(root: string, manifestPath: string): string {
	const dir = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
	return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir.slice(dir.lastIndexOf("/") + 1);
}
