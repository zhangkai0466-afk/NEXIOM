import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["apps/desktop/update.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  target: "node24",
});
const { obsoleteReleaseDirectoryNames, resolveDesktopUpdateTarget } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("desktop updates resolve a newer sibling release from the shortcut", () => {
  const current = path.resolve("release/NEXIOM-0.6.17-win-x64/NEXIOM.exe");
  const target = path.resolve("release/NEXIOM-0.6.18-win-x64/NEXIOM.exe");
  assert.deepEqual(resolveDesktopUpdateTarget(target, current), {
    executable: target,
    targetVersion: "0.6.18",
  });
});

test("release cleanup selects only older valid sibling versions", () => {
  assert.deepEqual(
    obsoleteReleaseDirectoryNames(
      [
        "NEXIOM-0.6.16-win-x64",
        "NEXIOM-0.6.17-win-x64",
        "NEXIOM-0.6.18-win-x64",
        "NEXIOM-0.6.19-win-x64",
        "notes",
        "NEXIOM-latest-win-x64",
      ],
      "NEXIOM-0.6.18-win-x64",
    ),
    ["NEXIOM-0.6.16-win-x64", "NEXIOM-0.6.17-win-x64"],
  );
  assert.deepEqual(
    obsoleteReleaseDirectoryNames(["NEXIOM-0.6.17-win-x64"], "development"),
    [],
  );
  assert.deepEqual(
    obsoleteReleaseDirectoryNames(
      [
        "NEXIOM-0.6.19-win-x64",
        "NEXIOM-0.6.20-win-x64",
        ".nexiom-previous-2cb21b55-39dc-4c6c-bc74-b8c701ec08df",
        ".nexiom-update-in-progress",
        "notes",
      ],
      "NEXIOM-current-win-x64",
    ),
    [
      "NEXIOM-0.6.19-win-x64",
      "NEXIOM-0.6.20-win-x64",
      ".nexiom-previous-2cb21b55-39dc-4c6c-bc74-b8c701ec08df",
    ],
  );
});

test("desktop updates reject stale, malformed, and unrelated shortcut targets", () => {
  const current = path.resolve("release/NEXIOM-0.6.17-win-x64/NEXIOM.exe");
  assert.throws(
    () => resolveDesktopUpdateTarget(current, current),
    /已经是.*最新版本/,
  );
  assert.throws(
    () =>
      resolveDesktopUpdateTarget(
        path.resolve("release/NEXIOM-0.6.16-win-x64/NEXIOM.exe"),
        current,
      ),
    /没有指向比当前版本更新/,
  );
  assert.throws(
    () => resolveDesktopUpdateTarget(path.resolve("release/latest.exe"), current),
    /有效的 NEXIOM\.exe/,
  );
  assert.throws(
    () => resolveDesktopUpdateTarget(path.resolve("release/latest/NEXIOM.exe"), current),
    /受支持的版本目录/,
  );
  assert.throws(
    () =>
      resolveDesktopUpdateTarget(
        path.resolve("elsewhere/NEXIOM-0.6.18-win-x64/NEXIOM.exe"),
        current,
      ),
    /另一个 NEXIOM 发布目录/,
  );
});
