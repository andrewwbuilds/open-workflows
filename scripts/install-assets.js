#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const fallbackRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = process.env.INIT_CWD ?? process.cwd() ?? fallbackRoot

const targets = [
  { src: "agents", dest: join(homedir(), ".config", "opencode", "agents") },
  { src: "commands", dest: join(homedir(), ".config", "opencode", "commands") },
]

let copied = 0
let skipped = 0

for (const { src, dest } of targets) {
  const sourceDir = join(root, src)
  if (!existsSync(sourceDir)) continue
  try {
    mkdirSync(dest, { recursive: true })
  } catch (error) {
    console.warn(`open-workflows: could not create ${dest}: ${errorMessage(error)}`)
    skipped += 1
    continue
  }
  for (const entry of readDir(sourceDir)) {
    if (!entry.endsWith(".md")) continue
    const from = join(sourceDir, entry)
    const to = join(dest, entry)
    try {
      copyFileSync(from, to)
      chmodSync(to, 0o644)
      copied += 1
    } catch (error) {
      console.warn(`open-workflows: failed to copy ${entry} -> ${dest}: ${errorMessage(error)}`)
      skipped += 1
    }
  }
}

if (copied > 0) {
  console.log(`open-workflows: copied ${copied} agent/command file(s) into ~/.config/opencode/`)
}
if (skipped > 0) {
  console.log(`open-workflows: ${skipped} file(s) skipped; copy them manually if needed (see INSTALL.md).`)
}

function readDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}