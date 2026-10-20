// Turns dist-webos into an installable LG TV package (.ipk) in build-webos/: adds appinfo.json
// (with the version from package.json) and the icons, then runs LG's ares-package.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const info = JSON.parse(readFileSync("webos/appinfo.json", "utf8"));
writeFileSync("dist-webos/appinfo.json", JSON.stringify({ ...info, version }, null, 2));
for (const f of ["icon.png", "largeIcon.png", "splash.png"]) copyFileSync(`webos/${f}`, `dist-webos/${f}`);
mkdirSync("build-webos", { recursive: true });
execFileSync("npx", ["ares-package", "dist-webos", "-o", "build-webos", "--no-minify"], { stdio: "inherit" });
