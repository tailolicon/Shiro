import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The bridge has to survive being INSTALLED, not just being imported from its
// own checkout.
//
// It ran fine for a long time while being unpublishable: the profile links it
// with `link:`, which brings the whole directory along, so every module was
// there regardless of what package.json claimed. `npm pack` tells the truth,
// and it was packing nine fewer modules than `index.js` transitively needs --
// a .tgz or a clean install would have thrown ERR_MODULE_NOT_FOUND on the
// first import. Nothing caught it because nothing ever installed the package.
//
// So this file is the gate: compute what the exports actually reach, and
// require package.json to carry exactly that.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function manifest() {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
}

/** Every local module reachable from an entrypoint, following relative imports. */
function reachableFrom(entrypoints) {
  const seen = new Set()
  const queue = [...entrypoints]
  while (queue.length > 0) {
    const current = queue.pop()
    if (seen.has(current)) continue
    const absolute = join(ROOT, current)
    if (!existsSync(absolute)) continue
    seen.add(current)
    const source = execFileSync('cat', [absolute], { encoding: 'utf8' })
    for (const match of source.matchAll(/from '(\.\.?\/[\w./-]+)'/g)) {
      queue.push(normalize(join(dirname(current), match[1])))
    }
  }
  return seen
}

test('every module the exports reach is listed in files[]', async () => {
  const pkg = await manifest()
  const entrypoints = Object.values(pkg.exports).map(value => value.replace(/^\.\//, ''))
  const reachable = reachableFrom(entrypoints)
  const listed = new Set(pkg.files)

  const missing = [...reachable].filter(file => !listed.has(file)).sort()
  assert.deepEqual(missing, [], 'these modules are imported but would not be packaged')

  // The other direction matters too: a stale entry means a file that was
  // deleted or renamed still claims to ship.
  const stale = pkg.files.filter(file => file.startsWith('src/') && !existsSync(join(ROOT, file))).sort()
  assert.deepEqual(stale, [], 'these files[] entries do not exist')
})

test('the documented public entrypoints are all exported', async () => {
  const pkg = await manifest()
  // docs/CONNECTOR_ACTIONS.md and README call the JS SDK public; an export map
  // that omits it makes `import '@shiro-ai/harness-bridge/sdk'` fail for every
  // consumer that is not reading the source tree directly.
  for (const subpath of ['.', './container-tool', './git-tool', './host-tool', './document-tool', './sdk']) {
    assert.ok(pkg.exports[subpath], `${subpath} must be exported`)
    assert.ok(existsSync(join(ROOT, pkg.exports[subpath])), `${subpath} points at a missing file`)
  }
})

test('npm pack ships every reachable module', async t => {
  // The real check, against npm's own file selection rather than a re-reading
  // of files[]: .npmignore, defaults and negations all get a vote here.
  const cache = await mkdtemp(join(tmpdir(), 'shiro-npm-cache-'))
  t.after(() => rm(cache, { recursive: true, force: true }))
  const listed = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_cache: cache },
  })
  const packed = new Set(JSON.parse(listed)[0].files.map(entry => entry.path))

  const pkg = await manifest()
  const reachable = reachableFrom(Object.values(pkg.exports).map(value => value.replace(/^\.\//, '')))
  const missing = [...reachable].filter(file => !packed.has(file)).sort()
  assert.deepEqual(missing, [], 'npm pack would omit these modules')
  assert.ok(packed.has('package.json'))
})

test('a packed tarball installs into an empty directory and every export imports', async t => {
  // The end-to-end proof: pack, install into a directory that shares nothing
  // with this checkout, and import each public entrypoint. This is what a
  // consumer actually does, and the only check that would have caught the
  // original breakage.
  const staging = await mkdtemp(join(tmpdir(), 'shiro-pack-'))
  t.after(() => rm(staging, { recursive: true, force: true }))

  // npm's default cache lives in $HOME, which is read-only whenever this suite
  // itself runs confined -- point it inside the staging directory so the test
  // is hermetic and passes under `test_run` with a narrowed sandbox_mode too.
  const hermetic = { ...process.env, npm_config_cache: join(staging, 'npm-cache') }
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', staging], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: hermetic,
  }))[0].filename
  const tarball = join(staging, packed)

  const consumer = join(staging, 'consumer')
  execFileSync('mkdir', ['-p', consumer])
  execFileSync('npm', ['init', '-y'], { cwd: consumer, stdio: 'ignore', env: hermetic })
  // --no-package-lock keeps this from touching any shared store; the engine
  // peer stays absent on purpose, since it is optional.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: consumer, stdio: 'ignore', env: hermetic })

  const pkg = await manifest()
  for (const subpath of Object.keys(pkg.exports)) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`
    // container-tool and git-tool import the OPTIONAL engine peer, which a bare
    // consumer install does not have -- so a missing '@deepseek-ai/dsh-tools'
    // is the expected outcome there, while any missing './...' module is the
    // packaging bug this test exists to catch.
    const script = `
      try {
        await import(${JSON.stringify(specifier)})
        console.log('OK')
      } catch (error) {
        console.log(error.code === 'ERR_MODULE_NOT_FOUND' && /@deepseek-ai/.test(error.message) ? 'PEER' : 'BROKEN:' + error.message)
      }`
    const outcome = execFileSync('node', ['--input-type=module', '-e', script], { cwd: consumer, encoding: 'utf8' }).trim()
    assert.match(outcome, /^(OK|PEER)$/, `${specifier} failed to import from a clean install: ${outcome}`)
  }
})
