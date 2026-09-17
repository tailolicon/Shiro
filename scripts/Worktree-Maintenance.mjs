#!/usr/bin/env node
import { resolve } from 'node:path'
import { managedMaintenance } from '../bridge/src/worktree-policy.js'
import { parseWorktreeList } from '../bridge/src/worktree-actions.js'
const args = process.argv.slice(2)
if (args.includes('--help') || !args.includes('--repo')) {
  console.log('node scripts/Worktree-Maintenance.mjs --repo /absolute/repo [--apply]\nDry run by default. Only expired tool-owned, clean, merged, idle checkouts without ignored data are eligible. No force removal.')
  process.exit(args.includes('--help') ? 0 : 2)
}
const index = args.indexOf('--repo')
if (!args[index + 1]) throw new Error('--repo requires a path')
console.log(JSON.stringify(await managedMaintenance(resolve(args[index + 1]), parseWorktreeList, { apply: args.includes('--apply') }), null, 2))
