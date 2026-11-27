declare module "*.css";
/** Vite bundles the file as a worker script and gives its URL (the sound section's AudioWorklet). */
declare module "*?worker&url" {
	const url: string;
	export default url;
}
