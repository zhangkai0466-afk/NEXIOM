import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rename,
  access,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { rcedit } from "rcedit";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("This packaging script targets Windows x64.");
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const destinationFlag = process.argv.indexOf("--destination");
const requestedDestination =
  destinationFlag >= 0 ? process.argv[destinationFlag + 1] : null;
if (destinationFlag >= 0 && !requestedDestination)
  throw new Error("--destination requires a directory.");
const destination = requestedDestination
  ? path.resolve(requestedDestination)
  : path.resolve(`release/NEXIOM-${metadata.version}-win-x64`);
if (requestedDestination) {
  const releaseRoot = path.resolve("release");
  if (
    path.dirname(destination).toLowerCase() !== releaseRoot.toLowerCase() ||
    !/^\.nexiom-update-[0-9a-f-]+$/i.test(path.basename(destination))
  )
    throw new Error("The update destination must be a generated staging directory under release.");
}
try {
  await access(destination);
  throw new Error(
    `Output already exists: ${destination}. Choose a new version before packaging.`,
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(destination, { recursive: true });
await cp("node_modules/electron/dist", destination, { recursive: true });
await rename(
  path.join(destination, "electron.exe"),
  path.join(destination, "NEXIOM.exe"),
);
await rcedit(path.join(destination, "NEXIOM.exe"), {
  icon: path.resolve("assets/brand/nexiom-desktop-icon.ico"),
  "file-version": metadata.version,
  "product-version": metadata.version,
  "version-string": {
    CompanyName: "NEXIOM",
    FileDescription: "NEXIOM Mathematical Modeling Agent",
    ProductName: "NEXIOM",
    InternalName: "NEXIOM",
    OriginalFilename: "NEXIOM.exe",
  },
});
const app = path.join(destination, "resources/app");
await mkdir(app, { recursive: true });
for (const item of [".build", "dist", "assets/brand", "packages/visualization-engine"])
  await cp(item, path.join(app, item), {
    recursive: true,
    filter: (source) => !source.endsWith(".map") && !/[\\/](?:__pycache__|\.pytest_cache|PaperSpec)(?:[\\/]|$)/.test(source) && !source.endsWith(".pyc"),
  });
await writeFile(
  path.join(app, "package.json"),
  JSON.stringify(
    {
      name: "nexiom",
      productName: "NEXIOM",
      version: metadata.version,
      main: ".build/desktop.cjs",
    },
    null,
    2,
  ),
);
await cp(
  "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc",
  path.join(destination, "resources/codex"),
  { recursive: true },
);
await cp("vendor/codex-sdk", path.join(destination, "licenses/codex-sdk"), {
  recursive: true,
});
await cp(
  "THIRD_PARTY_NOTICES.md",
  path.join(destination, "THIRD_PARTY_NOTICES.md"),
);
await cp("README.md", path.join(destination, "README.md"));
await cp("docs", path.join(destination, "docs"), { recursive: true });
await mkdir(path.join(destination, "scripts"), { recursive: true });
await cp(
  "scripts/create-shortcut.ps1",
  path.join(destination, "scripts/create-shortcut.ps1"),
);
await mkdir(path.join(destination, "licenses/fonts/noto-sans-sc"), { recursive: true });
for (const file of ["OFL.txt", "PROVENANCE.md"])
  await cp(
    path.join("assets/fonts/noto-sans-sc", file),
    path.join(destination, "licenses/fonts/noto-sans-sc", file),
  );
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev || !location.includes("node_modules/")) continue;
  let files;
  try {
    files = await readdir(location);
  } catch {
    continue;
  }
  const licenseDir = path.join(
    destination,
    "licenses/npm",
    location.replaceAll("node_modules/", "").replaceAll("/", "__"),
  );
  await mkdir(licenseDir, { recursive: true });
  await writeFile(
    path.join(licenseDir, "package-notice.json"),
    JSON.stringify(
      {
        name: info.name ?? location.split("node_modules/").at(-1),
        version: info.version,
        license: info.license,
      },
      null,
      2,
    ),
  );
  for (const file of files.filter((name) =>
    /^(licen[cs]e|notice|copying)([.-].*)?$/i.test(name),
  ))
    await cp(path.join(location, file), path.join(licenseDir, file), {
      recursive: true,
    });
}
console.log(path.join(destination, "NEXIOM.exe"));
