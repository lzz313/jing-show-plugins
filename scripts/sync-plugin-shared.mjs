#!/usr/bin/env node
/**
 * Copy the canonical shared client into each host plugin.
 *
 * Orca validates only files inside a plugin folder, and Herdr loads modules
 * beside the mod, so both hosts need their own copy. This script is the only
 * writer; tests assert the copies stay byte-identical to the canonical source.
 *
 *   node scripts/sync-plugin-shared.mjs          # write the copies
 *   node scripts/sync-plugin-shared.mjs --check  # exit 1 on drift
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['jing-client.mjs', 'jing-client.d.mts']
const targets = [
  'herdr/jing-show/lib',
  'src/vendor',
]

const check = process.argv.includes('--check')
let drifted = false

for (const dir of targets) {
  for (const file of files) {
    const source = path.join(root, 'shared', file)
    const target = path.join(root, dir, file)
    const body = await readFile(source)
    if (check) {
      let current = null
      try {
        current = await readFile(target)
      } catch {
        // Missing copies count as drift.
      }
      if (!current || !current.equals(body)) {
        console.error(`drift: ${path.relative(root, target)}`)
        drifted = true
      }
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
    console.log(`synced ${path.relative(root, target)}`)
  }
}

if (drifted) process.exitCode = 1
