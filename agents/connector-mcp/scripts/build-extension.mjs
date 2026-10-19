import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(packageRoot, "release");
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "extension", "manifest.json"), "utf8"),
);
if (manifest.server.entry_point !== "server/index.mjs") {
  throw new Error("Extension manifest entry point changed unexpectedly");
}
const staging = mkdtempSync(join(tmpdir(), "webank-mcpb-"));
const output = join(releaseDir, `webank-agent-wallet-${manifest.version}.mcpb`);
const partial = `${output}.partial`;
try {
  mkdirSync(join(staging, "server"));
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [join(packageRoot, "src", "index.ts")],
    outfile: join(staging, "server", "bundle.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "bundle",
    legalComments: "eof",
    metafile: true,
    sourcemap: false,
  });
  const bundledPackages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const file = realpathSync(resolve(packageRoot, input));
    if (!file.includes("/node_modules/")) continue;
    let directory = dirname(file);
    while (directory !== dirname(directory)) {
      const packageJson = join(directory, "package.json");
      if (existsSync(packageJson)) {
        const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
        if (metadata.name && metadata.version) {
          bundledPackages.set(`${metadata.name}@${metadata.version}`, {
            directory,
            metadata,
          });
          break;
        }
      }
      directory = dirname(directory);
    }
    if (directory === dirname(directory)) {
      throw new Error(
        `Cannot find package metadata for bundled input: ${input}`,
      );
    }
  }
  const noticeLines = ["Third-party licenses bundled in server/bundle.mjs", ""];
  for (const [identity, { directory, metadata }] of [...bundledPackages].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const licenseFiles = readdirSync(directory).filter((name) =>
      /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(name),
    );
    if (licenseFiles.length === 0) {
      throw new Error(`Missing license text for bundled package ${identity}`);
    }
    const licenseDirectory = join(
      staging,
      "notices",
      "licenses",
      encodeURIComponent(identity),
    );
    mkdirSync(licenseDirectory, { recursive: true });
    noticeLines.push(`${identity} (${metadata.license ?? "see license text"})`);
    for (const name of licenseFiles.sort()) {
      writeFileSync(
        join(licenseDirectory, name),
        readFileSync(join(directory, name)),
      );
      noticeLines.push(
        `  notices/licenses/${encodeURIComponent(identity)}/${name}`,
      );
    }
    noticeLines.push("");
  }
  writeFileSync(
    join(staging, "notices", "THIRD_PARTY_NOTICES.txt"),
    `${noticeLines.join("\n")}\n`,
  );
  writeFileSync(
    join(staging, "server", "index.mjs"),
    [
      "process.env.WEBANK_GATEWAY_URL ||= 'http://127.0.0.1:3002';",
      "const { runConnectorStdio } = await import('./bundle.mjs');",
      "await runConnectorStdio();",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  mkdirSync(releaseDir, { recursive: true });
  rmSync(partial, { force: true });
  execFileSync(
    "zip",
    ["-q", "-X", "-r", partial, "manifest.json", "server", "notices"],
    { cwd: staging },
  );
  renameSync(partial, output);
  process.stdout.write(`${output}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(partial, { force: true });
}
