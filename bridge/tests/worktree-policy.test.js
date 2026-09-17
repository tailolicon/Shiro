import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { addWorktree, parseWorktreeList, defaultWorktreePath } from '../src/worktree-actions.js'
import { managedMaintenance, validateSparsePaths } from '../src/worktree-policy.js'

async function fixture() {
 const base = await mkdtemp(join(tmpdir(), 'shiro-storage-test-')); const root = join(base, 'repo')
 execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
 const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString()
 git('config','user.name','Test'); git('config','user.email','test@local')
 await writeFile(join(root,'README.md'),'small root file\n'); await mkdir(join(root,'src'))
 await writeFile(join(root,'src','main.js'),'export const x = 1\n'); git('add','.');git('commit','-m','initial')
 return { base, root, git, sandbox:new Sandbox(root), close:()=>rm(base,{recursive:true,force:true}) }
}

test('read-only workers do not materialize a checkout',async()=>{
 const f=await fixture();try {
 const destination=defaultWorktreePath(f.root,'read')
 await assert.rejects(addWorktree(f.sandbox,{branch:'read',destination,purpose:'read_only'}),e=>e.code==='INVALID_ARGUMENT')
 assert.equal(existsSync(destination),false)
 }finally{await f.close()}
})

test('linked checkout count is bounded before branch creation',async()=>{
 const f=await fixture();try {
 f.git('config','shiro.worktreeMaxLinked','1')
 await addWorktree(f.sandbox,{branch:'one',destination:defaultWorktreePath(f.root,'one')})
 await assert.rejects(addWorktree(f.sandbox,{branch:'two',destination:defaultWorktreePath(f.root,'two')}),e=>e.code==='BUSY')
 assert.equal(f.git('branch','--list','two').trim(),'')
 }finally{await f.close()}
})

test('large data checkout is refused but sparse code checkout succeeds',async()=>{
 const f=await fixture();try {
 await mkdir(join(f.root,'data'));await writeFile(join(f.root,'data','large.bin'),Buffer.alloc(2000000,7))
 f.git('add','.');f.git('commit','-m','large data');f.git('config','shiro.worktreeMaxCheckoutBytes','4096')
 await assert.rejects(addWorktree(f.sandbox,{branch:'full',destination:defaultWorktreePath(f.root,'full')}),e=>e.code==='CONFLICT')
 const destination=defaultWorktreePath(f.root,'sparse')
 await addWorktree(f.sandbox,{branch:'sparse',destination,sparse_paths:['src']})
 assert.equal(existsSync(join(destination,'data','large.bin')),false)
 assert.equal(await readFile(join(destination,'src','main.js'),'utf8'),'export const x = 1\n')
 }finally{await f.close()}
})

test('nested directories and hostile sparse paths are refused',async()=>{
 const f=await fixture();try {
 await assert.rejects(addWorktree(f.sandbox,{branch:'nested',destination:join(f.root,'.tmp')}),e=>e.code==='INVALID_ARGUMENT')
 for(const paths of [['../secret'],['/tmp'],['.git'],['src/../data'],['--all']])assert.throws(()=>validateSparsePaths(paths))
 }finally{await f.close()}
})

test('maintenance is dry-run first; only expired clean merged managed checkouts are removed',async()=>{
 const f=await fixture();try {
 const clean=defaultWorktreePath(f.root,'clean');const dirty=defaultWorktreePath(f.root,'dirty')
 await addWorktree(f.sandbox,{branch:'clean',destination:clean})
 await addWorktree(f.sandbox,{branch:'dirty',destination:dirty})
 await writeFile(join(dirty,'new.txt'),'important uncommitted work')
 const future=Date.now()+48*3600000
 const plan=await managedMaintenance(f.root,parseWorktreeList,{now:future})
 assert.equal(plan.dry_run,true);assert.equal(existsSync(clean),true)
 assert.equal(plan.worktrees.find(w=>w.path===clean).eligible,true)
 assert.equal(plan.worktrees.find(w=>w.path===dirty).reason,'dirty_preserve_first')
 const applied=await managedMaintenance(f.root,parseWorktreeList,{now:future,apply:true})
 assert.equal(applied.worktrees.find(w=>w.path===clean).removed,true)
 assert.equal(existsSync(dirty),true);assert.ok(f.git('branch','--list','clean').trim())
 assert.ok(f.git('for-each-ref','refs/shiro/retired').trim())
 }finally{await f.close()}
})

test('worktree with ignored or unmerged data is retained',async()=>{
 const f=await fixture();try {
 const ignored=defaultWorktreePath(f.root,'ignored');const unmerged=defaultWorktreePath(f.root,'unmerged')
 await addWorktree(f.sandbox,{branch:'ignored',destination:ignored})
 await writeFile(join(ignored,'.gitignore'),'precious.bin\n');execFileSync('git',['add','.gitignore'],{cwd:ignored});execFileSync('git',['commit','-m','ignore config'],{cwd:ignored,stdio:'pipe'})
 await writeFile(join(ignored,'precious.bin'),'not garbage')
 await addWorktree(f.sandbox,{branch:'unmerged',destination:unmerged})
 await writeFile(join(unmerged,'feature.txt'),'new source');execFileSync('git',['add','.'],{cwd:unmerged});execFileSync('git',['commit','-m','unmerged change'],{cwd:unmerged,stdio:'pipe'})
 const report=await managedMaintenance(f.root,parseWorktreeList,{now:Date.now()+48*3600000,apply:true})
 assert.equal(report.worktrees.find(w=>w.path===ignored).reason,'ignored_data_preserve_first')
 assert.equal(report.worktrees.find(w=>w.path===unmerged).reason,'unmerged_preserve_first')
 assert.equal(existsSync(join(ignored,'precious.bin')),true)
 }finally{await f.close()}
})


test('sparse budget includes large ancestor files',async()=>{
 const f=await fixture();try {
 await mkdir(join(f.root,'src','deep'))
 await writeFile(join(f.root,'src','large-parent.bin'),Buffer.alloc(200000,2))
 await writeFile(join(f.root,'src','deep','tiny.js'),'small\n')
 f.git('add','.');f.git('commit','-m','ancestor data');f.git('config','shiro.worktreeMaxCheckoutBytes','4096')
 await assert.rejects(addWorktree(f.sandbox,{branch:'nested-sparse',destination:defaultWorktreePath(f.root,'nested-sparse'),sparse_paths:['src/deep']}),e=>e.code==='CONFLICT')
 }finally{await f.close()}
})
