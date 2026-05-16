#!/usr/bin/env node
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const targetArg = process.argv[2] ?? "../openclaw";
const targetPath = path.resolve(repoRoot, targetArg);
const linkPath = path.join(repoRoot, "node_modules", "openclaw");

async function exists(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const targetStat = await exists(targetPath);
if (!targetStat?.isDirectory()) {
  throw new Error(`OpenClaw checkout not found: ${targetPath}`);
}

await mkdir(path.dirname(linkPath), { recursive: true });
const current = await exists(linkPath);
if (current) {
  if (!current.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace non-symlink dependency at ${linkPath}. Remove it manually first.`,
    );
  }
  await rm(linkPath);
}

await symlink(targetPath, linkPath, "dir");
console.log(`Linked node_modules/openclaw -> ${targetPath}`);
