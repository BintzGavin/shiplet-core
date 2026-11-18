// Vite's ?raw loader returns a file's text. Used for trace session fixtures.
declare module "*.jsonl?raw" {
	const text: string;
	export default text;
}
