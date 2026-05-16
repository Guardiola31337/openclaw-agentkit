#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cli = process.env.CLAWHUB_CLI?.trim() || "clawhub";
const dryRun = process.argv.includes("--dry-run");
const json = process.argv.includes("--json");

const clawscanNote =
  "World AgentKit integration: contacts World/AgentKit APIs, can open a local verifier callback, and uses OpenClaw operator approval APIs to resolve protected-tool HITL approvals after proof verification.";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return options.capture ? result.stdout.trim() : "";
}

const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true });
const sourceRef = run("git", ["branch", "--show-current"], { capture: true }) || "main";

const args = [
  "--workdir",
  root,
  "package",
  "publish",
  root,
  "--family",
  "code-plugin",
  "--owner",
  "guardiola31337",
  "--version",
  packageJson.version,
  "--source-repo",
  "Guardiola31337/openclaw-agentkit",
  "--source-commit",
  sourceCommit,
  "--source-ref",
  sourceRef,
  "--clawscan-note",
  clawscanNote,
  "--tags",
  "beta",
];

if (dryRun) args.push("--dry-run");
if (json) args.push("--json");

const command = cli.endsWith(".js") ? process.execPath : cli;
const commandArgs = cli.endsWith(".js") ? [cli, ...args] : args;
run(command, commandArgs);
