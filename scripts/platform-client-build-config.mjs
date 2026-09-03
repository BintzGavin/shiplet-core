export function createPlatformClientBuildConfig({
	entry,
	fileName,
	outDir,
	plugins = [],
	root,
}) {
	return {
		configFile: false,
		define: {
			"process.env": "{}",
			"process.env.NODE_ENV": JSON.stringify("production"),
		},
		envDir: false,
		mode: "production",
		root,
		plugins,
		build: {
			codeSplitting: false,
			emptyOutDir: false,
			lib: {
				entry,
				formats: ["es"],
				fileName: () => fileName,
			},
			minify: "esbuild",
			outDir,
			sourcemap: false,
			target: "es2022",
		},
	};
}
