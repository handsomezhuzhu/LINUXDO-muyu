import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import { pack } from "@discourse-mini-app/sdk/pack";
import { copyFile, readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile("manifest.json", "utf8")
) as MiniAppManifest;
manifest.id = process.env.MINI_APP_ID || manifest.id;
manifest.version = process.env.MINI_APP_VERSION || manifest.version;
if (
  manifest.id === "019a2a58-0000-7000-8000-000000000001" &&
  process.env.MINI_APP_ALLOW_EXAMPLE_ID !== "1"
) {
  throw new Error(
    "Refusing to package with the documentation example app ID. " +
    "Set MINI_APP_ID to the platform-assigned application ID, " +
    "or explicitly set MINI_APP_ALLOW_EXAMPLE_ID=1 for CI-only builds."
  );
}
const apiOrigin = process.env.MINI_APP_API_ORIGIN?.replace(/\/+$/, "");
if (apiOrigin) {
  const paths = {
    getState: "/v1/state",
    syncMerit: "/v1/merit/sync",
    createWish: "/v1/wishes",
  };
  for (const [name, path] of Object.entries(paths)) {
    const endpoint = manifest.endpoints?.[name];
    if (endpoint) endpoint.url = `${apiOrigin}${path}`;
  }
}
await copyFile("src/template.html", "dist/web/index.html");
await copyFile("src/strings.json", "dist/web/strings.json");
const files: Record<string, Buffer> = {};
for (const name of ["index.html", "app.js", "app.css", "strings.json"]) {
  files[name] = await readFile(`dist/web/${name}`);
}
const resources = [
  ...(manifest.assets || []),
  ...Object.values(manifest.media || {}).map((item) => item.path),
];
for (const path of new Set(resources)) {
  if (
    !/^[a-zA-Z0-9_.\-/]{1,160}$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid package asset path");
  }
  files[path] = await readFile(`dist/web/${path}`);
}
const result = await pack({ manifest, files, outputDirectory: "dist/package" });
console.log(
  `Created ${result.file} (${result.size} bytes), app ${manifest.id}, version ${manifest.version}`
);
