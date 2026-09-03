#!/usr/bin/env node
// The `shiro` command. Everything worth testing lives in ../src/cli.js; this
// file is the part that cannot be tested without a process: argv, exit codes,
// and closing the transport.
import { EXIT, runCli, UsageError } from '../src/cli.js'
import { connect } from '../src/cli-connect.js'

const argv = process.argv.slice(2)

// help and usage errors must not need a running bridge.
const offline = argv.length === 0 || ['help', '--help', '-h'].includes(argv[0])
if (offline) {
  process.exitCode = await runCli(argv, { client: null })
} else {
  let session
  try {
    session = await connect()
    process.exitCode = await runCli(argv, { client: session.client })
  } catch (error) {
    console.error(error?.message ?? String(error))
    process.exitCode = error?.exitCode ?? (error instanceof UsageError ? EXIT.usage : EXIT.transport)
  } finally {
    await session?.close()
  }
}
