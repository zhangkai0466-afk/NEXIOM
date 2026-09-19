import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const commit = "6b9826e3aa83b1a5947db50f4332cb9c65f1b340";
const upstream = path.resolve("vendor/codex");
if (
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: upstream,
    encoding: "utf8",
  }).trim() !== commit
)
  throw new Error("Unexpected Codex source revision");
const target = path.resolve("vendor/codex-sdk");
await mkdir(target, { recursive: true });
await cp(path.join(upstream, "sdk/typescript/src"), path.join(target, "src"), {
  recursive: true,
  force: false,
  errorOnExist: true,
});
for (const file of ["LICENSE", "NOTICE"])
  await cp(path.join(upstream, file), path.join(target, file));
await cp(
  path.join(upstream, "sdk/typescript/README.md"),
  path.join(target, "UPSTREAM-README.md"),
);
await writeFile(
  path.join(target, "provenance.json"),
  JSON.stringify(
    {
      repository: "https://github.com/openai/codex",
      tag: "rust-v0.154.0",
      commit,
      path: "sdk/typescript/src",
      license: "Apache-2.0",
    },
    null,
    2,
  ) + "\n",
);
console.log("Imported pinned Codex TypeScript SDK source.");
