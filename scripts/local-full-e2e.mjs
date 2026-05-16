#!/usr/bin/env node
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  return `Usage: pnpm test:local-full-e2e [-- --openclaw <path>] [--skip-host-build] [--skip-link]

Runs the local AgentKit proof against a compatible OpenClaw checkout.

Options:
  --openclaw <path>     OpenClaw checkout to link. Defaults to ../openclaw-agentkit-host-apis, then ../openclaw.
  --skip-host-build     Do not run pnpm build in the OpenClaw checkout first.
  --skip-link           Do not replace node_modules/openclaw with a symlink.
  --help                Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    openclaw: process.env.OPENCLAW_E2E_HOST,
    skipHostBuild: false,
    skipLink: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--skip-host-build") {
      options.skipHostBuild = true;
      continue;
    }
    if (arg === "--skip-link") {
      options.skipLink = true;
      continue;
    }
    if (arg === "--openclaw") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--openclaw requires a path");
      }
      options.openclaw = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolveOpenClawPath(openclawArg) {
  const candidates = openclawArg
    ? [openclawArg]
    : ["../openclaw-agentkit-host-apis", "../openclaw"];

  for (const candidate of candidates) {
    const candidatePath = path.resolve(repoRoot, candidate);
    if (!(await exists(path.join(candidatePath, "package.json")))) {
      continue;
    }
    const packageJson = JSON.parse(
      await readFile(path.join(candidatePath, "package.json"), "utf8"),
    );
    if (packageJson.name === "openclaw") {
      return await realpath(candidatePath);
    }
  }

  throw new Error(
    `Could not find an OpenClaw checkout. Pass one with --openclaw <path> or set OPENCLAW_E2E_HOST.`,
  );
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  console.log(`\n$ ${[command, ...args].join(" ")}\n  cwd: ${cwd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const openclawRoot = await resolveOpenClawPath(options.openclaw);

console.log(`Using OpenClaw checkout: ${openclawRoot}`);

if (!options.skipHostBuild) {
  await run("pnpm", ["build"], { cwd: openclawRoot });
}

if (!options.skipLink) {
  await run("node", ["scripts/link-openclaw-dev.mjs", openclawRoot]);
}

await run("pnpm", ["test:hitl"]);
await run("pnpm", ["test:openclaw-hitl"]);

console.log(
  "\nAgentKit local full E2E passed: plugin HITL logic and real OpenClaw gateway approval flow both completed.",
);
