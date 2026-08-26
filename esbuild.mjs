import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

const shared = {
  bundle: true,
  logLevel: "info",
  platform: "node",
  sourcemap: production ? false : "linked",
  target: "node20",
};

const buildOptions = tests
  ? {
      ...shared,
      entryPoints: ["test/integration/suite/index.ts"],
      external: ["vscode"],
      format: "cjs",
      outfile: "dist/test/suite/index.js",
    }
  : {
      ...shared,
      entryPoints: ["src/extension.ts"],
      external: ["vscode"],
      format: "cjs",
      minify: production,
      outfile: "dist/extension.js",
    };

if (watch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log("Watching the InReview extension bundle.");
} else {
  await esbuild.build(buildOptions);
}
