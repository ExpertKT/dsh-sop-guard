/**
 * Run: node test/guard.test.mjs
 * Exercises the SOP guard against a fake Cordis context. Covers the seven
 * design defects found in review:
 *  1 per-step tools + command whitelist checked against real arguments
 *  2 advancing a step requires evidence
 *  3 a declaration lasts the whole step, not one call
 *  4 no lock/strike escalation exists
 *  5 `done` exits; plain and broken skill loads do not silently disarm
 *  6 the prompt section is static text (KV cache stays stable)
 *  7 several checklists coexist and can be switched
 * Plus warn mode, invalid regex, reserved ids, skipping, and disposal.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function makeCtx(config = {}) {
  const tools = new Map()
  const listeners = new Map()
  const warnings = []
  const registered = []
  const agentState = { list: [], owners: new Map() }
  let guard = () => undefined
  let section
  let context
  const ctx = {
    logger: { warn: (text) => warnings.push(text), info() {} },
    systemPrompt: {
      getSectionOrder: () => 40,
      section: (value) => (section = value),
      context: (value) => (context = value),
    },
    tools: {
      register: (definition) => tools.set(definition.name, definition),
      guard: (fn) => { guard = fn },
    },
    on: (event, handler) => listeners.set(event, handler),
    get: (name) => (name === 'commands' ? { register: (definition) => registered.push(definition) } : undefined),
    agents: {
      list: () => agentState.list,
      isOwnedBy: (id, owner) => agentState.owners.get(String(id)) === owner,
    },
  }
  apply(ctx, { stateDir: false, ...config })
  return {
    tools,
    section,
    context: () => context,
    // What the framework renders for one agent in one assembly.
    stepContext: (agent) => (context === undefined ? '' : context.text({ agent, scope: agent })),
    warnings,
    registered,
    agentState,
    guard: (name, agent, args = {}) => guard({ name, agent, arguments: args }),
    // The framework runs post-execute (awaited), then fires tools/result
    // (fire-and-forget). Arming must happen in the awaited phase.
    emitSkill: async (agent, name, dir, isError = false) => {
      const result = isError
        ? { isError: true }
        : { isError: false, value: { name, resourceBase: { kind: 'directory', path: dir } } }
      const armed = await listeners.get('tools/post-execute')(
        { name: 'skill', agent, arguments: { name } },
        result,
        async () => ({ kind: 'accept' }),
      )
      listeners.get('tools/result')({ name: 'skill', agent, arguments: { name } }, result)
      return armed.additionalContexts ?? []
    },
    declare: (agent, args = {}) => tools.get('sop_step').execute(args, { agent }),
    emitResult: (agent, name, isError = false, value = undefined) =>
      listeners.get('tools/result')(
        { name, agent, arguments: { command: 'git status' } },
        { isError, ...(value === undefined ? {} : { value }) },
      ),
    emitPostExecute: async (agent, name, value) => {
      const handler = listeners.get('tools/post-execute')
      const downstream = await handler(
        { name, agent, arguments: { name } },
        { isError: false, value },
        async () => ({ kind: 'accept' }),
      )
      return downstream.additionalContexts ?? []
    },
    dispose: (agent) => listeners.get('agent/disposed')({ agent }),
    // The framework's serial dispatch awaits each `agent/created` listener's
    // returned promise before publishing the agent's loop, so restore must be
    // finished by the time this resolves.
    created: async (agent) => { await listeners.get('agent/created')({ agent }) },
  }
}

async function makeSkill(sop) {
  const dir = await mkdtemp(join(tmpdir(), 'sop-guard-'))
  if (sop !== undefined) await writeFile(join(dir, 'SOP.json'), JSON.stringify(sop), 'utf8')
  return dir
}

const SOP = {
  version: 1,
  steps: [
    { id: 'inspect', title: '看现状', tools: ['pwsh'], commands: ['^git (branch|status|rev-parse)\\b', '^head\\b'] },
    { id: 'propose', title: '提议方案', tools: [] },
    { id: 'create', title: '创建', tools: ['pwsh'], commands: ['^git worktree add\\b'] },
  ],
}
const agent = { id: 'agent-a' }
const dirs = []
try {
  // 1. Deny before declaration with an actionable reason; reads stay ungated.
  const dir = await makeSkill(SOP)
  dirs.push(dir)
  const ctx = makeCtx()
  await ctx.emitSkill(agent, 'demo', dir)
  const denied = ctx.guard('write', agent)
  assert.match(denied, /SOP 未通过检测/)
  assert.match(denied, /第 1\/3 步「看现状」/)
  assert.match(denied, /sop_step\(\{"step":"inspect"\}\)/)
  assert.match(denied, /本步命令白名单/)
  assert.match(denied, /SOP\.json/)
  assert.equal(ctx.guard('read', agent), undefined)

  // The framework awaits tools/post-execute before committing a result but
  // fires tools/result observers without awaiting them. Arming must finish in
  // the awaited phase: firing only post-execute must already gate the next call.
  const armedCtx = makeCtx()
  const armedAgent = { id: 'agent-arm-phase' }
  await armedCtx.emitPostExecute(armedAgent, 'skill', {
    name: 'demo', resourceBase: { kind: 'directory', path: dir },
  })
  assert.match(armedCtx.guard('write', armedAgent), /SOP 未通过检测/)
  assert.match(armedCtx.declare(armedAgent, { step: 'inspect' }), /本步已申报/)
  assert.match(armedCtx.guard('write', armedAgent), /本步不允许调用 write/)

  // 3. One declaration covers every call in the step; a denied command does not consume it.
  assert.match(ctx.declare(agent, { step: 'inspect' }), /本步已申报/)
  assert.equal(ctx.guard('pwsh', agent, { command: 'git branch -a' }), undefined)
  assert.equal(ctx.guard('pwsh', agent, { command: 'git status | head -30' }), undefined)
  assert.equal(ctx.guard('pwsh', agent, { command: 'git rev-parse --show-toplevel' }), undefined)
  assert.equal(ctx.guard('pwsh', agent, { command: 'git status' }), undefined)

  // 1 (the real check): command content and tool name are both validated.
  assert.match(ctx.guard('pwsh', agent, { command: 'Set-Content -Path x -Value y' }), /命令片段/)
  assert.match(ctx.guard('pwsh', agent, { command: 'git status; Set-Content -Path x -Value y' }), /命令片段/)
  assert.match(ctx.guard('write', agent), /本步不允许调用 write/)
  assert.match(ctx.guard('bash', agent, {}), /无法读取命令内容|本步不允许调用 bash/)
  assert.match(ctx.guard('pwsh', agent, { command: 'git status $(Remove-Item x)' }), /命令替换/)
  assert.match(ctx.guard('pwsh', agent, { command: 'git status > stolen.txt' }), /重定向/)
  assert.match(ctx.guard('pwsh', agent, { command: 'git status `whoami`' }), /命令替换/)
  assert.equal(ctx.guard('pwsh', agent, { command: 'git status' }), undefined)

  // 4. No lock exists: repeated denials stay ordinary, and recovery is immediate.
  const noLockCtx = makeCtx()
  const noLockAgent = { id: 'agent-lock' }
  await noLockCtx.emitSkill(noLockAgent, 'demo', dir)
  for (let round = 0; round < 6; round += 1) {
    const reason = noLockCtx.guard('pwsh', noLockAgent, { command: 'git status' })
    assert.match(reason, /SOP 未通过检测/)
    assert.doesNotMatch(reason, /已锁定/)
  }
  noLockCtx.declare(noLockAgent, { step: 'inspect' })
  assert.equal(noLockCtx.guard('pwsh', noLockAgent, { command: 'git status' }), undefined)

  // 2. Advancing requires evidence; skipping steps is refused; evidence is recorded.
  assert.throws(() => ctx.declare(agent, { step: 'propose' }), /必须给 evidence/)
  assert.throws(() => ctx.declare(agent, { step: 'propose', evidence: 'ok' }), /必须给 evidence/)
  assert.throws(() => ctx.declare(agent, { step: 'create' }), /不在可申报范围内/)
  ctx.emitResult(agent, 'pwsh')
  assert.match(ctx.declare(agent, { step: 'propose', evidence: '分支风格为两段式 type/name' }), /第 2\/3 步/)
  assert.match(ctx.declare(agent, {}), /上一步申报依据：分支风格为两段式 type\/name/)
  // Advancing does not declare the next step: it needs its own declaration.
  assert.match(ctx.guard('write', agent), /本步还没有申报/)
  assert.match(ctx.declare(agent, { step: 'propose' }), /本步已申报/)
  assert.match(ctx.guard('write', agent), /本步不允许调用 write/)
  assert.throws(() => ctx.declare(agent, { step: 'inspect' }), /不在可申报范围内/)

  // 5. `done` is the only exit; plain/broken loads no longer silently disarm.
  const plainDir = await mkdtemp(join(tmpdir(), 'sop-guard-plain-'))
  dirs.push(plainDir)
  const exitCtx = makeCtx()
  const exitAgent = { id: 'agent-exit' }
  await exitCtx.emitSkill(exitAgent, 'demo', dir)
  exitCtx.declare(exitAgent, { step: 'inspect' })
  exitCtx.emitResult(exitAgent, 'pwsh')
  await exitCtx.emitSkill(exitAgent, 'plain', plainDir)
  assert.match(exitCtx.guard('write', exitAgent), /SOP 未通过检测/)
  const brokenDir = await makeSkill({ version: 2, steps: [] })
  dirs.push(brokenDir)
  await exitCtx.emitSkill(exitAgent, 'broken', brokenDir)
  assert.match(exitCtx.guard('write', exitAgent), /SOP 未通过检测/)
  assert.equal(exitCtx.warnings.length, 1)
  assert.match(exitCtx.warnings[0], /invalid and was skipped/)
  assert.match(exitCtx.declare(exitAgent, { step: 'done', evidence: '检查了清单问题，本流程到此结束' }), /当前会话没有生效中的 SOP 流程/)
  assert.equal(exitCtx.guard('write', exitAgent), undefined)

  // 6. The prompt section is a constant string; advancing never changes it.
  assert.equal(typeof ctx.section.text, 'string')
  const promptBefore = ctx.section.text
  ctx.declare(agent, { step: 'create', evidence: '用户已确认分支名 feat/sop-guard' })
  assert.equal(ctx.section.text, promptBefore)
  assert.match(ctx.guard('pwsh', agent, { command: 'git worktree add ../x -b feat/x' }), /本步还没有申报/)
  ctx.declare(agent, { step: 'create' })
  assert.equal(ctx.guard('pwsh', agent, { command: 'git worktree add ../x -b feat/x' }), undefined)
  assert.match(ctx.guard('pwsh', agent, { command: 'git status' }), /命令片段/)

  // 6b. The live step is broadcast as runtime context: the model that drifted
  // off the checklist gets its position restated before the next call.
  assert.equal(ctx.stepContext(agent).length > 0, true)
  assert.match(ctx.stepContext(agent), /第 3\/3 步「创建」/)
  assert.match(ctx.stepContext(agent), /本步已申报/)
  assert.match(ctx.stepContext(agent), /本步命令白名单：\^git worktree add\\b/)
  assert.match(ctx.stepContext(agent), /已是最后一步/)
  // Nothing armed and no agent: the broadcast stays empty, so it costs no
  // context and does not touch the runtime-context snapshot at all.
  assert.equal(ctx.stepContext({ id: 'agent-unknown' }), '')
  assert.equal(ctx.stepContext(undefined), '')
  // Undeclared steps say so, and name the exact call that fixes it.
  const driftCtx = makeCtx()
  const driftAgent = { id: 'agent-drift' }
  await driftCtx.emitSkill(driftAgent, 'demo', dir)
  assert.match(driftCtx.stepContext(driftAgent), /本步尚未申报：先调用 sop_step\(\{"step":"inspect"\}\)/)
  driftCtx.declare(driftAgent, { step: 'inspect' })
  assert.match(driftCtx.stepContext(driftAgent), /本步已申报/)
  assert.match(driftCtx.stepContext(driftAgent), /下一步「提议方案」/)
  driftCtx.emitResult(driftAgent, 'pwsh')
  // Ending the last flow stops the broadcast: nothing left to remind about.
  driftCtx.declare(driftAgent, { step: 'done', evidence: '检查完现状，本流程到此结束' })
  assert.equal(driftCtx.stepContext(driftAgent), '')

  // 6c. `/sop off` is the human's escape hatch: a wrong checklist, or a model
  // pinned against it, must not be something only the model can undo.
  const offCtx = makeCtx()
  const offAgent = { id: 'agent-off' }
  await offCtx.emitSkill(offAgent, 'demo', dir)
  const command = offCtx.registered.find((entry) => entry.name === 'sop')
  assert.equal(command.handler({ agent: offAgent, rawInput: '' }).kind, 'success')
  assert.match(command.handler({ agent: offAgent, rawInput: '' }).text, /第 1\/3 步/)
  const disarmed = command.handler({ agent: offAgent, rawInput: ' off ' })
  assert.match(disarmed.text, /已解除本会话的 SOP 流程（demo）/)
  // The gate is genuinely off, and stays off across the next assembly.
  assert.equal(offCtx.guard('write', offAgent), undefined)
  assert.equal(offCtx.stepContext(offAgent), '')
  assert.match(offCtx.warnings.at(-1), /disarmed by the user/)
  // Asking again is harmless, and an agentless invocation does not throw.
  assert.match(command.handler({ agent: offAgent, rawInput: 'off' }).text, /没有生效中的 SOP/)
  assert.match(command.handler({ rawInput: 'off' }).text, /没有生效中的 SOP/)

  // 7. Several checklists coexist; `skill` switches; `done` falls back to the other.
  const otherDir = await makeSkill({ version: 1, steps: [{ id: 'only', title: '唯一一步', tools: ['write'] }] })
  dirs.push(otherDir)
  const multiCtx = makeCtx()
  const multiAgent = { id: 'agent-multi' }
  await multiCtx.emitSkill(multiAgent, 'demo', dir)
  await multiCtx.emitSkill(multiAgent, 'other', otherDir)
  assert.match(multiCtx.declare(multiAgent, {}), /demo, other\(生效中\)/)
  assert.match(multiCtx.guard('write', multiAgent), /SOP 未通过检测/)
  assert.match(multiCtx.declare(multiAgent, { step: 'only' }), /第 1\/1 步「唯一一步」/)
  assert.equal(multiCtx.guard('write', multiAgent), undefined)
  assert.match(multiCtx.declare(multiAgent, { skill: 'demo' }), /demo\(生效中\)/)
  assert.match(multiCtx.declare(multiAgent, { step: 'inspect' }), /第 1\/3 步/)
  assert.match(multiCtx.guard('write', multiAgent), /本步不允许调用 write/)
  assert.throws(() => multiCtx.declare(multiAgent, { skill: 'ghost' }), /尚未装载/)
  multiCtx.emitResult(multiAgent, 'pwsh')
  assert.match(multiCtx.declare(multiAgent, { step: 'done', evidence: '本流程已完成并切换到另一个' }), /other\(生效中\)/)
  assert.equal(multiCtx.guard('write', multiAgent), undefined)

  // warn mode logs but does not deny; disposal clears the session.
  const warnCtx = makeCtx({ mode: 'warn' })
  const warnAgent = { id: 'agent-warn' }
  await warnCtx.emitSkill(warnAgent, 'demo', dir)
  assert.equal(warnCtx.guard('write', warnAgent), undefined)
  assert.equal(warnCtx.warnings.length, 1)
  assert.match(warnCtx.warnings[0], /SOP 未通过检测/)
  warnCtx.dispose(warnAgent)
  assert.equal(warnCtx.guard('write', warnAgent), undefined)
  assert.throws(() => warnCtx.declare(warnAgent, {}), /没有已装载的 SOP/)

  // Invalid command regex, reserved step id, and errored skill loads cannot arm.
  const badDir = await makeSkill({ version: 1, steps: [{ id: 'only', title: 'x', tools: ['pwsh'], commands: ['(unclosed'] }] })
  dirs.push(badDir)
  const badCtx = makeCtx()
  await badCtx.emitSkill({ id: 'agent-bad' }, 'bad', badDir)
  assert.equal(badCtx.guard('write', { id: 'agent-bad' }), undefined)
  assert.match(badCtx.warnings[0], /正则/)
  const reservedDir = await makeSkill({ version: 1, steps: [{ id: 'done', title: 'x' }] })
  dirs.push(reservedDir)
  const reservedCtx = makeCtx()
  await reservedCtx.emitSkill({ id: 'agent-reserved' }, 'reserved', reservedDir)
  assert.match(reservedCtx.warnings[0], /保留字/)
  const errCtx = makeCtx()
  const errAgent = { id: 'agent-err' }
  await errCtx.emitSkill(errAgent, 'demo', dir, true)
  assert.equal(errCtx.guard('write', errAgent), undefined)

  // UTF-8 BOM from Windows editors must not make a checklist silently vanish.
  const bomDir = await mkdtemp(join(tmpdir(), 'sop-guard-bom-'))
  dirs.push(bomDir)
  await writeFile(join(bomDir, 'SOP.json'), '\uFEFF' + JSON.stringify(SOP), 'utf8')
  const bomCtx = makeCtx()
  const bomAgent = { id: 'agent-bom' }
  await bomCtx.emitSkill(bomAgent, 'bom', bomDir)
  assert.match(bomCtx.guard('write', bomAgent), /SOP 未通过检测/)

  // A step that allows a shell without a command whitelist refuses the shell:
  // with nothing to check a command against, it would run unchecked.
  const looseDir = await makeSkill({ version: 1, steps: [{ id: 'free', title: '宽松步', tools: ['pwsh'] }] })
  dirs.push(looseDir)
  const looseCtx = makeCtx()
  const looseAgent = { id: 'agent-loose' }
  await looseCtx.emitSkill(looseAgent, 'loose', looseDir)
  looseCtx.declare(looseAgent, { step: 'free' })
  assert.match(looseCtx.guard('pwsh', looseAgent, { command: 'Remove-Item -Recurse x' }), /未声明命令白名单/)
  assert.match(looseCtx.declare(looseAgent, {}), /未声明 commands/)

  // Config is a trust boundary: an unknown mode fails closed.
  assert.throws(() => makeCtx({ mode: 'silent' }), /mode must be/)

  // After `done`: status query works, switch reports "not loaded", step refuses cleanly.
  const emptyCtx = makeCtx()
  const emptyAgent = { id: 'agent-empty' }
  await emptyCtx.emitSkill(emptyAgent, 'demo', dir)
  emptyCtx.declare(emptyAgent, { step: 'inspect' })
  emptyCtx.emitResult(emptyAgent, 'pwsh')
  emptyCtx.declare(emptyAgent, { step: 'done', evidence: '验证已完成，无需继续流程' })
  assert.match(emptyCtx.declare(emptyAgent, {}), /没有生效中的 SOP 流程/)
  assert.throws(() => emptyCtx.declare(emptyAgent, { skill: 'demo' }), /尚未装载/)
  assert.throws(() => emptyCtx.declare(emptyAgent, { step: 'inspect' }), /没有生效中的 SOP/)
  assert.equal(emptyCtx.guard('write', emptyAgent), undefined)

  // action preflight only rejects gated tools; read-class tools are not checked.
  const preCtx = makeCtx()
  const preAgent = { id: 'agent-pre' }
  await preCtx.emitSkill(preAgent, 'demo', dir)
  assert.match(preCtx.declare(preAgent, { step: 'inspect', action: 'read' }), /本步已申报/)
  assert.throws(() => preCtx.declare(preAgent, { step: 'inspect', action: 'write' }), /不允许 write/)
  // A rejected call leaves the flow where it was: the action is checked
  // against the step the call lands on, before anything is written.
  preCtx.emitResult(preAgent, 'pwsh')
  assert.throws(() => preCtx.declare(preAgent, { step: 'propose', action: 'write', evidence: '分支风格为两段式' }), /不允许 write/)
  assert.match(preCtx.declare(preAgent, {}), /第 1\/3 步/)
  assert.match(preCtx.declare(preAgent, { step: 'propose', evidence: '分支风格为两段式' }), /第 2\/3 步/)
  assert.equal(preCtx.guard('read', preAgent), undefined)

  // evidence is anchored to an observed successful execution in tool-declaring
  // steps; failed calls do not count; tools: [] steps are reasoning-only.
  const workCtx = makeCtx()
  const workAgent = { id: 'agent-work' }
  await workCtx.emitSkill(workAgent, 'demo', dir)
  workCtx.declare(workAgent, { step: 'inspect' })
  assert.throws(
    () => workCtx.declare(workAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }),
    /成功的工具执行记录/,
  )
  workCtx.emitResult(workAgent, 'pwsh', true)
  assert.throws(
    () => workCtx.declare(workAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }),
    /成功的工具执行记录/,
  )
  workCtx.emitResult(workAgent, 'pwsh')
  assert.match(workCtx.declare(workAgent, {}), /本步已观察到 1 次成功的工具执行/)
  assert.match(workCtx.declare(workAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }), /第 2\/3 步/)
  assert.match(workCtx.declare(workAgent, { step: 'create', evidence: '用户已确认分支名 feat/x' }), /第 3\/3 步/)

  // `done` drops the whole gate, so it is no cheaper than advancing: the
  // step must be declared, tool-declaring steps need observed work, and the
  // exit still leaves an audit log entry.
  const bailCtx = makeCtx()
  const bailAgent = { id: 'agent-bail' }
  await bailCtx.emitSkill(bailAgent, 'demo', dir)
  assert.throws(
    () => bailCtx.declare(bailAgent, { step: 'done', evidence: '用户取消，无需继续流程' }),
    /还没有申报/,
  )
  bailCtx.declare(bailAgent, { step: 'inspect' })
  assert.throws(() => bailCtx.declare(bailAgent, { step: 'done' }), /必须给 evidence/)
  assert.throws(
    () => bailCtx.declare(bailAgent, { step: 'done', evidence: '用户取消，无需继续流程' }),
    /成功的工具执行记录/,
  )
  bailCtx.emitResult(bailAgent, 'pwsh')
  assert.match(bailCtx.declare(bailAgent, { step: 'done', evidence: '用户取消，无需继续流程' }), /没有生效中的 SOP 流程/)
  assert.match(bailCtx.warnings.join('\n'), /early exit/)
  assert.equal(bailCtx.guard('write', bailAgent), undefined)

  // A reasoning-only step has no work to observe, but `done` still needs its
  // declaration; a witness step still needs a real read.
  const reasonDir = await makeSkill({ version: 1, steps: [{ id: 'think', title: '想一想', tools: [] }] })
  dirs.push(reasonDir)
  const reasonCtx = makeCtx()
  const reasonAgent = { id: 'agent-reason-exit' }
  await reasonCtx.emitSkill(reasonAgent, 'reasoned', reasonDir)
  assert.throws(
    () => reasonCtx.declare(reasonAgent, { step: 'done', evidence: '想清楚了，流程到此结束' }),
    /还没有申报/,
  )
  reasonCtx.declare(reasonAgent, { step: 'think' })
  assert.match(reasonCtx.declare(reasonAgent, { step: 'done', evidence: '想清楚了，流程到此结束' }), /没有生效中的 SOP 流程/)
  const witnessExitDir = await makeSkill({
    version: 1,
    steps: [{ id: 'review', title: '读依据', tools: [], witness: true }],
  })
  dirs.push(witnessExitDir)
  const witnessExitCtx = makeCtx()
  const witnessExitAgent = { id: 'agent-witness-exit' }
  await witnessExitCtx.emitSkill(witnessExitAgent, 'witnessed-exit', witnessExitDir)
  witnessExitCtx.declare(witnessExitAgent, { step: 'review' })
  assert.throws(
    () => witnessExitCtx.declare(witnessExitAgent, { step: 'done', evidence: '已经看过相关材料了' }),
    /要求先真实读取依据/,
  )
  witnessExitCtx.emitResult(witnessExitAgent, 'read', false, { content: [{ type: 'text', text: '…' }] })
  assert.match(witnessExitCtx.declare(witnessExitAgent, { step: 'done', evidence: '已经看过相关材料了' }), /没有生效中的 SOP 流程/)

  const raceCtx = makeCtx()
  const raceAgent = { id: 'agent-race' }
  const pending = raceCtx.emitSkill(raceAgent, 'demo', dir)
  raceCtx.dispose(raceAgent)
  await pending
  assert.equal(raceCtx.guard('write', raceAgent), undefined)
  assert.throws(() => raceCtx.declare(raceAgent, {}), /没有已装载的 SOP/)

  // A quoted separator is text, not a command boundary: `git log --grep "a;b"`
  // stays one segment and is matched as a whole.
  const quoteCtx = makeCtx()
  const quoteAgent = { id: 'agent-quote' }
  const quoteDir = await makeSkill({
    version: 1,
    steps: [{ id: 'read', title: '查日志', tools: ['pwsh'], commands: ['^git log --grep "a;b"$'] }],
  })
  dirs.push(quoteDir)
  await quoteCtx.emitSkill(quoteAgent, 'quote', quoteDir)
  quoteCtx.declare(quoteAgent, { step: 'read' })
  assert.equal(quoteCtx.guard('pwsh', quoteAgent, { command: 'git log --grep "a;b"' }), undefined)
  assert.match(quoteCtx.guard('pwsh', quoteAgent, { command: 'git log --grep "a" ; Remove-Item x' }), /命令片段/)

  // `2>&1` only duplicates a descriptor; `>` writing to a file stays denied.
  const redirectCtx = makeCtx()
  const redirectAgent = { id: 'agent-redirect' }
  await redirectCtx.emitSkill(redirectAgent, 'demo', dir)
  redirectCtx.declare(redirectAgent, { step: 'inspect' })
  assert.equal(redirectCtx.guard('pwsh', redirectAgent, { command: 'git status 2>&1' }), undefined)
  assert.match(redirectCtx.guard('pwsh', redirectAgent, { command: 'git status > stolen.txt' }), /重定向/)

  // Double quotes still expand substitution, and a quote inside them does not
  // start a single-quoted run that would hide the rest of the command.
  const quoteMixCtx = makeCtx()
  const quoteMixAgent = { id: 'agent-quote-mix' }
  await quoteMixCtx.emitSkill(quoteMixAgent, 'demo', dir)
  quoteMixCtx.declare(quoteMixAgent, { step: 'inspect' })
  assert.match(
    quoteMixCtx.guard('pwsh', quoteMixAgent, { command: 'git status "it\'s $(Remove-Item x)"' }),
    /命令替换/,
  )
  assert.equal(quoteMixCtx.guard('pwsh', quoteMixAgent, { command: "git status '$(Remove-Item x)'" }), undefined)

  // Reloading the same skill refreshes the checklist without rewinding progress.
  const reloadCtx = makeCtx()
  const reloadAgent = { id: 'agent-reload' }
  await reloadCtx.emitSkill(reloadAgent, 'demo', dir)
  reloadCtx.declare(reloadAgent, { step: 'inspect' })
  reloadCtx.emitResult(reloadAgent, 'pwsh')
  assert.match(reloadCtx.declare(reloadAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }), /第 2\/3 步/)
  await reloadCtx.emitSkill(reloadAgent, 'demo', dir)
  assert.match(reloadCtx.declare(reloadAgent, {}), /第 2\/3 步/)

  // Editing SOP.json while it is loaded must not carry a declaration or
  // observed work onto a different step id. restoreFlow compares ids on
  // restart; the in-session reload has to do the same. Reload deliberately
  // happens while the flow sits on a declared step with work already done:
  // keeping that state at the same numeric index would let the next gated
  // call through undeclared.
  const editedDir = await makeSkill(SOP)
  dirs.push(editedDir)
  const editReloadCtx = makeCtx()
  const editReloadAgent = { id: 'agent-edit-reload' }
  await editReloadCtx.emitSkill(editReloadAgent, 'demo', editedDir)
  editReloadCtx.declare(editReloadAgent, { step: 'inspect' })
  editReloadCtx.emitResult(editReloadAgent, 'pwsh')
  await writeFile(
    join(editedDir, 'SOP.json'),
    JSON.stringify({
      version: 1,
      steps: [
        { id: 'gather', title: '收集材料', tools: ['pwsh'], commands: ['^git status\\b'] },
        { id: 'review', title: '核对方案', tools: [], witness: true, approval: true },
        { id: 'commit', title: '提交', tools: ['pwsh'], commands: ['^git commit\\b'] },
      ],
    }),
    'utf8',
  )
  await editReloadCtx.emitSkill(editReloadAgent, 'demo', editedDir)
  assert.match(editReloadCtx.declare(editReloadAgent, {}), /第 1\/3 步「收集材料」/)
  assert.match(editReloadCtx.stepContext(editReloadAgent), /本步尚未申报：先调用 sop_step/)
  assert.match(
    editReloadCtx.warnings.at(-1),
    /the checklist for "demo" changed while it was loaded; restarted at step 1/,
  )
  assert.match(
    editReloadCtx.guard('pwsh', editReloadAgent, { command: 'git status' }),
    /本步还没有申报/,
  )
  // The reloaded checklist is fully usable: its witness and approval steps
  // still gate advancing, so a reset does not simply skip the new rules.
  editReloadCtx.declare(editReloadAgent, { step: 'gather' })
  editReloadCtx.emitResult(editReloadAgent, 'pwsh')
  assert.match(
    editReloadCtx.declare(editReloadAgent, { step: 'review', evidence: '已经收齐材料可以核对' }),
    /第 2\/3 步/,
  )
  editReloadCtx.declare(editReloadAgent, { step: 'review' })
  // requireApproval runs before requireObservedWork, so approval fires first.
  assert.throws(
    () => editReloadCtx.declare(editReloadAgent, { step: 'commit', evidence: '方案已经仔细看过了' }),
    /必须由用户运行 \/sop approve/,
  )
  const editReloadCommand = editReloadCtx.registered.find((entry) => entry.name === 'sop')
  assert.match(
    editReloadCommand.handler({ agent: editReloadAgent, rawInput: 'approve' }).text,
    /已确认当前步骤/,
  )
  assert.throws(
    () => editReloadCtx.declare(editReloadAgent, { step: 'commit', evidence: '人也点头了，可以提交' }),
    /要求先真实读取依据/,
  )
  editReloadCtx.emitResult(editReloadAgent, 'read')
  assert.match(
    editReloadCtx.declare(editReloadAgent, { step: 'commit', evidence: '读过了，人也点头了' }),
    /第 3\/3 步/,
  )

  // A resumed session reuses the agent id with a new instance and can arm again.
  const resumeCtx = makeCtx()
  const resumeAgent = { id: 'agent-resume' }
  await resumeCtx.emitSkill(resumeAgent, 'demo', dir)
  resumeCtx.dispose(resumeAgent)
  const resumedAgent = { id: 'agent-resume' }
  await resumeCtx.created(resumedAgent)
  await resumeCtx.emitSkill(resumedAgent, 'demo', dir)
  assert.match(resumeCtx.guard('write', resumedAgent), /SOP 未通过检测/)

  // The exit hint matches the contract: `done` needs an evidence argument.
  assert.match(ctx.guard('write', agent), /sop_step\(\{"step":"done","evidence":"\.\.\."\}\)/)

  // `run_code` carries a program, not a command line. Its payload is never
  // split or matched against the command whitelist, and the transport stays
  // usable whenever the step allows any tool; each nested call is gated on
  // its own.
  const programCtx = makeCtx()
  const programAgent = { id: 'agent-program' }
  await programCtx.emitSkill(programAgent, 'demo', dir)
  programCtx.declare(programAgent, { step: 'inspect' })
  const program = 'const a = 1; const b = a < 2; await tools.pwsh({ command: "git status" })'
  assert.equal(programCtx.guard('run_code', programAgent, { code: program }), undefined)

  // A step that allows no tool at all also blocks the transport.
  const bareCtx = makeCtx()
  const bareAgent = { id: 'agent-bare-step' }
  await bareCtx.emitSkill(bareAgent, 'demo', dir)
  bareCtx.declare(bareAgent, { step: 'inspect' })
  bareCtx.emitResult(bareAgent, 'pwsh')
  bareCtx.declare(bareAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' })
  bareCtx.declare(bareAgent, { step: 'propose' })
  assert.match(bareCtx.guard('run_code', bareAgent, { code: program }), /本步不允许调用 run_code/)

  // A program body must not reach past the step's rules: the file modules
  // change files without the file tools, the process module runs commands
  // without the command patterns.
  const fsProgram = 'const fs = await import("node:fs"); fs.writeFileSync("x.txt", "1")'
  assert.match(
    programCtx.guard('run_code', programAgent, { code: fsProgram }),
    /绕过本步的 write\/edit/,
  )
  const execProgram = 'const { execSync } = await import("node:child_process"); execSync("git status")'
  assert.match(
    programCtx.guard('run_code', programAgent, { code: execProgram }),
    /绕过本步的命令白名单/,
  )
  const builtinProgram = 'const { getBuiltinModule } = await import("node:process"); getBuiltinModule("fs").writeFileSync("x.txt", "1")'
  assert.match(
    programCtx.guard('run_code', programAgent, { code: builtinProgram }),
    /绕过本步的 write\/edit/,
  )
  const variableProgram = 'const m = "node:fs"; const fs = await import(m); fs.writeFileSync("x.txt", "1")'
  assert.match(
    programCtx.guard('run_code', programAgent, { code: variableProgram }),
    /绕过本步的 write\/edit/,
  )
  // The same body on a step that allows the file tools is not a side channel
  // for a file change: that step already allows them.
  const fileDir = await makeSkill({
    version: 1,
    steps: [{ id: 'inspect', title: '看现状', tools: ['write', 'pwsh'] }],
  })
  dirs.push(fileDir)
  const fileCtx = makeCtx()
  const fileAgent = { id: 'agent-file-step' }
  await fileCtx.emitSkill(fileAgent, 'demo', fileDir)
  fileCtx.declare(fileAgent, { step: 'inspect' })
  assert.equal(fileCtx.guard('run_code', fileAgent, { code: fsProgram }), undefined)

  // A step that allows only ungated tools still advances: the observed work is
  // any allowed tool call, not only a gated one.
  const ungatedCtx = makeCtx()
  const ungatedAgent = { id: 'agent-ungated-step' }
  const ungatedDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'peek', title: '读文件', tools: ['read'] },
      { id: 'report', title: '汇报', tools: [] },
    ],
  })
  dirs.push(ungatedDir)
  await ungatedCtx.emitSkill(ungatedAgent, 'peek', ungatedDir)
  ungatedCtx.declare(ungatedAgent, { step: 'peek' })
  assert.throws(
    () => ungatedCtx.declare(ungatedAgent, { step: 'report', evidence: '已经读完文件内容，可以汇报' }),
    /还没有任何成功的工具执行记录/,
  )
  ungatedCtx.emitResult(ungatedAgent, 'read')
  assert.match(
    ungatedCtx.declare(ungatedAgent, { step: 'report', evidence: '已经读完文件内容，可以汇报' }),
    /第 2\/2 步/,
  )

  // A shell command that failed is a report, not work: a non-zero exit code
  // leaves the step without observed work, so it cannot advance on that alone.
  const failedCtx = makeCtx()
  const failedAgent = { id: 'agent-failed-command' }
  await failedCtx.emitSkill(failedAgent, 'demo', dir)
  failedCtx.declare(failedAgent, { step: 'inspect' })
  failedCtx.emitResult(failedAgent, 'pwsh', false, { exitCode: 1 })
  assert.throws(
    () => failedCtx.declare(failedAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }),
    /还没有任何成功的工具执行记录/,
  )
  failedCtx.emitResult(failedAgent, 'pwsh', false, { exitCode: 0 })
  assert.match(
    failedCtx.declare(failedAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }),
    /第 2\/3 步/,
  )

  // An unrestricted step (no `tools` key) still needs one observed run.
  const freeCtx = makeCtx()
  const freeAgent = { id: 'agent-free-step' }
  const freeDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'free', title: '不限工具' },
      { id: 'after', title: '之后', tools: [] },
    ],
  })
  dirs.push(freeDir)
  await freeCtx.emitSkill(freeAgent, 'free', freeDir)
  freeCtx.declare(freeAgent, { step: 'free' })
  assert.throws(
    () => freeCtx.declare(freeAgent, { step: 'after', evidence: '不限工具的一步也要有执行记录' }),
    /还没有任何成功的工具执行记录/,
  )
  freeCtx.emitResult(freeAgent, 'read')
  assert.match(
    freeCtx.declare(freeAgent, { step: 'after', evidence: '不限工具的一步也要有执行记录' }),
    /第 2\/2 步/,
  )

  // A broken checklist is announced to the model, not only to the host log.
  const brokenCtx = makeCtx()
  const brokenAgent = { id: 'agent-broken' }
  const invalidDir = await makeSkill({ version: 1, steps: [{ id: 'x', title: '坏清单', commands: ['^(unclosed'] }] })
  dirs.push(invalidDir)
  const brokenValue = { name: 'broken-demo', resourceBase: { kind: 'directory', path: invalidDir } }
  const notices = await brokenCtx.emitPostExecute(brokenAgent, 'skill', brokenValue)
  assert.equal(notices.length, 1)
  assert.match(notices[0].content[0].text, /SOP 清单无效/)
  assert.match(notices[0].content[0].text, /没有生效/)
  assert.equal(notices[0].source.kind, 'sop-guard')
  // A valid checklist produces no notice.
  const validCtx = makeCtx()
  const validAgent = { id: 'agent-valid' }
  const validNotices = await validCtx.emitPostExecute(validAgent, 'skill', {
    name: 'demo',
    resourceBase: { kind: 'directory', path: dir },
  })
  assert.equal(validNotices.length, 0)

  // The shell is parsed, not pattern-matched: quoting decides what expands.
  const parseCtx = makeCtx()
  const parseAgent = { id: 'agent-parse' }
  const parseDir = await makeSkill({
    version: 1,
    steps: [{ id: 'run', title: '跑命令', tools: ['pwsh'], commands: ['^git status$'] }],
  })
  dirs.push(parseDir)
  await parseCtx.emitSkill(parseAgent, 'parse', parseDir)
  parseCtx.declare(parseAgent, { step: 'run' })
  // A substitution inside double quotes still expands.
  assert.match(parseCtx.guard('pwsh', parseAgent, { command: 'git status "$(Remove-Item x)"' }), /命令替换/)
  // Inside single quotes it is literal text: no expansion, but the extra
  // argument still makes it a different command than the allowed one.
  assert.doesNotMatch(
    parseCtx.guard('pwsh', parseAgent, { command: "git status '$(Remove-Item x)'" }) ?? '',
    /命令替换/,
  )
  // A quoted `>` is literal text, not a redirect, but it is still an argument:
  // the command is no longer the allowed `git status`.
  assert.match(parseCtx.guard('pwsh', parseAgent, { command: 'git status ">" out.txt' }), /不在本步白名单内/)
  // Quoting only changes how an argument is delimited: `git 'status'` is `git status`.
  assert.equal(parseCtx.guard('pwsh', parseAgent, { command: "git 'status'" }), undefined)

  // The audit log pairs what the model claimed with what the host observed.
  const auditCtx = makeCtx()
  const auditAgent = { id: 'agent-audit' }
  await auditCtx.emitSkill(auditAgent, 'demo', dir)
  auditCtx.declare(auditAgent, { step: 'inspect' })
  auditCtx.emitResult(auditAgent, 'pwsh')
  auditCtx.declare(auditAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' })
  const auditLog = auditCtx.warnings.join('\n')
  assert.match(auditLog, /model evidence: 分支风格为两段式 type\/name/)
  assert.match(auditLog, /observed tool runs: pwsh ×1/)

  // A sub agent inherits the checklist of its parent: it must declare the step
  // itself, but it cannot escape the flow by running in its own session.
  const childCtx = makeCtx()
  const parentAgent = { id: 'agent-parent' }
  const childAgent = { id: 'agent-child' }
  childCtx.agentState.list = [parentAgent, childAgent]
  childCtx.agentState.owners.set('agent-child', parentAgent)
  await childCtx.emitSkill(parentAgent, 'demo', dir)
  await childCtx.created(childAgent)
  assert.match(childCtx.guard('write', childAgent), /本步还没有申报/)
  assert.match(childCtx.warnings.join('\n'), /inherited the armed SOP flow/)

  // A sub agent created before the parent armed its checklist must not slip
  // through ungated: the ancestor is looked up when the child acts.
  const lateCtx = makeCtx()
  const lateParent = { id: 'agent-late-parent' }
  const lateChild = { id: 'agent-late-child' }
  lateCtx.agentState.list = [lateParent, lateChild]
  lateCtx.agentState.owners.set('agent-late-child', lateParent)
  await lateCtx.created(lateChild)
  // The parent arms the flow only after the child already exists.
  await lateCtx.emitSkill(lateParent, 'demo', dir)
  assert.match(lateCtx.guard('write', lateChild), /本步还没有申报/)
  assert.match(lateCtx.warnings.join('\n'), /inherited the armed SOP flow/)

  // The armed flow is persisted, so a resumed session keeps its place.
  const stateDir = await mkdtemp(join(tmpdir(), 'sop-guard-state-'))
  dirs.push(stateDir)
  const persistCtx = makeCtx({ stateDir })
  const persistAgent = { id: 'agent-persist' }
  await persistCtx.emitSkill(persistAgent, 'demo', dir)
  persistCtx.declare(persistAgent, { step: 'inspect' })
  persistCtx.emitResult(persistAgent, 'pwsh')
  persistCtx.declare(persistAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' })
  const restoreCtx = makeCtx({ stateDir })
  // Persistence is asynchronous and the writes are chained, so wait until the
  // file on disk holds the advanced step, not merely until a file exists.
  const flowFile = join(stateDir, 'agent-persist.json')
  let persisted = undefined
  for (let round = 0; round < 50; round += 1) {
    if (existsSync(flowFile)) {
      try {
        persisted = JSON.parse(readFileSync(flowFile, 'utf8'))
      } catch {
        persisted = undefined
      }
      if (persisted?.bySkill?.demo?.index === 1) break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(persisted?.bySkill?.demo?.index, 1)
  await restoreCtx.created({ id: 'agent-persist' })
  // The serial dispatch awaits the restore: no polling, no race. The first
  // gated call must already see the flow.
  assert.match(restoreCtx.declare({ id: 'agent-persist' }, {}), /第 2\/3 步/)
  // A restored flow keeps its place but not its permission: the new process
  // must declare the step again before any tool runs.
  assert.match(restoreCtx.guard('write', { id: 'agent-persist' }), /本步还没有申报/)

  // A checklist that changed while the session was away cannot be resumed at
  // the old step: the step it reached no longer exists, so it starts over.
  const changedDir = await makeSkill(SOP)
  dirs.push(changedDir)
  const changedCtx = makeCtx({ stateDir })
  const changedAgent = { id: 'agent-changed' }
  await changedCtx.emitSkill(changedAgent, 'demo', changedDir)
  changedCtx.declare(changedAgent, { step: 'inspect' })
  changedCtx.emitResult(changedAgent, 'pwsh')
  changedCtx.declare(changedAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' })
  const changedFile = join(stateDir, 'agent-changed.json')
  for (let round = 0; round < 50; round += 1) {
    if (existsSync(changedFile)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Now the checklist on disk is a different one: the reached step id no
  // longer matches, so the restored flow must fall back to the first step.
  await writeFile(
    join(changedDir, 'SOP.json'),
    JSON.stringify({
      version: 1,
      steps: [
        { id: 'inspect', title: '看现状', tools: ['pwsh'], commands: ['^git (branch|status|rev-parse)\\b', '^head\\b'] },
        { id: 'analyze', title: '换个名字', tools: [] },
        { id: 'create', title: '创建', tools: ['pwsh'], commands: ['^git worktree add\\b'] },
      ],
    }),
    'utf8',
  )
  const changedRestore = makeCtx({ stateDir })
  await changedRestore.created({ id: 'agent-changed' })
  assert.match(changedRestore.declare({ id: 'agent-changed' }, {}), /第 1\/3 步/)

  // Ending a flow deletes its file. That delete is a write: if it ran beside a
  // save still in flight, the save would land afterwards and the resumed
  // session would re-arm a flow the model already ended.
  const doneCtx = makeCtx({ stateDir })
  const doneAgent = { id: 'agent-done' }
  await doneCtx.emitSkill(doneAgent, 'demo', dir)
  const doneFile = join(stateDir, 'agent-done.json')
  // Save first, so a delete with nothing queued cannot hide the defect.
  doneCtx.declare(doneAgent, { step: 'inspect' })
  for (let round = 0; round < 50; round += 1) {
    if (existsSync(doneFile)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(existsSync(doneFile), true)
  // Re-declare (queues a save) and end the flow in the same turn: the delete
  // must queue behind that save, not race it.
  doneCtx.declare(doneAgent, { step: 'inspect' })
  doneCtx.emitResult(doneAgent, 'pwsh')
  assert.match(doneCtx.declare(doneAgent, { step: 'done', evidence: '不再需要这条分支了' }), /已结束流程/)
  for (let round = 0; round < 50; round += 1) {
    if (!existsSync(doneFile)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Wait past the point where a late save would have landed.
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(existsSync(doneFile), false)
  const doneRestore = makeCtx({ stateDir })
  await doneRestore.created({ id: 'agent-done' })
  // Nothing to restore, so the gate is not armed and nothing is blocked.
  assert.equal(doneRestore.guard('write', { id: 'agent-done' }), undefined)

  // The user can read the same state without the model: `/sop` is registered.
  const commandCtx = makeCtx()
  assert.equal(commandCtx.registered.length, 1)
  assert.equal(commandCtx.registered[0].name, 'sop')
  const commandAgent = { id: 'agent-command' }
  await commandCtx.emitSkill(commandAgent, 'demo', dir)
  const answer = commandCtx.registered[0].handler({ agent: commandAgent })
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /demo\(生效中\)/)

  // A command must name a program plainly: a path can point at any file.
  const pathCtx = makeCtx()
  const pathAgent = { id: 'agent-bare' }
  const pathDir = await makeSkill({
    version: 1,
    steps: [{ id: 'run', title: '跑命令', tools: ['pwsh'], commands: ['^git status$'] }],
  })
  dirs.push(pathDir)
  await pathCtx.emitSkill(pathAgent, 'bare', pathDir)
  pathCtx.declare(pathAgent, { step: 'run' })
  assert.match(pathCtx.guard('pwsh', pathAgent, { command: '/bin/rm -rf x' }), /不能用路径调用/)
  assert.match(pathCtx.guard('pwsh', pathAgent, { command: '.\\evil.exe' }), /不能用路径调用/)

  // A step that allows a shell but no file tool must not reach the file
  // system through a file-writing command.
  const mutatorCtx = makeCtx()
  const mutatorAgent = { id: 'agent-mutator' }
  const mutatorDir = await makeSkill({
    version: 1,
    steps: [{ id: 'read', title: '只读', tools: ['pwsh', 'bash'], commands: ['^git .*$'] }],
  })
  dirs.push(mutatorDir)
  await mutatorCtx.emitSkill(mutatorAgent, 'mutator', mutatorDir)
  mutatorCtx.declare(mutatorAgent, { step: 'read' })
  assert.match(mutatorCtx.guard('pwsh', mutatorAgent, { command: 'Set-Content -Path x -Value y' }), /不允许 write\/edit/)
  // The writer can sit inside a command string: `pwsh -Command "Remove-Item x"`
  // still writes a file even though the program name is not a writer.
  assert.match(mutatorCtx.guard('pwsh', mutatorAgent, { command: 'pwsh -Command "Remove-Item x"' }), /不允许 write\/edit/)
  assert.match(mutatorCtx.guard('bash', mutatorAgent, { command: 'bash -c "rm -rf x"' }), /不允许 write\/edit/)
  // An encoded command line cannot be read, so it cannot be cleared either.
  assert.match(mutatorCtx.guard('pwsh', mutatorAgent, { command: 'pwsh -EncodedCommand ZQBjAGgAbwAgAHMAdABhAHQAdQBuAGMA' }), /编码命令/)
  assert.equal(mutatorCtx.guard('pwsh', mutatorAgent, { command: 'git status' }), undefined)

  // A whitelist pattern that matches every string is no whitelist at all.
  const catchAllDir = await makeSkill({
    version: 1,
    steps: [{ id: 'any', title: '全放行', tools: ['pwsh'], commands: ['.*'] }],
  })
  dirs.push(catchAllDir)
  const catchAllCtx = makeCtx()
  await catchAllCtx.emitSkill({ id: 'agent-catchall' }, 'catchall', catchAllDir)
  assert.match(catchAllCtx.warnings.join('\n'), /等于没有白名单/)

  // A failure that is not an exit code still does not count as work.
  const failCtx = makeCtx()
  const failAgent = { id: 'agent-failed' }
  await failCtx.emitSkill(failAgent, 'demo', dir)
  failCtx.declare(failAgent, { step: 'inspect' })
  failCtx.emitResult(failAgent, 'pwsh', false, { ok: false })
  assert.throws(
    () => failCtx.declare(failAgent, { step: 'propose', evidence: '分支风格为两段式 type/name' }),
    /成功的工具执行记录/,
  )

  // A notice about a broken checklist stays until the model has seen it.
  const noticeCtx = makeCtx()
  const noticeAgent = { id: 'agent-notice' }
  const noticeBroken = await makeSkill({ version: 3, steps: [] })
  dirs.push(noticeBroken)
  await noticeCtx.emitSkill(noticeAgent, 'broken', noticeBroken)
  assert.throws(() => noticeCtx.declare(noticeAgent, {}), /SOP 清单无效/)
  assert.throws(() => noticeCtx.declare(noticeAgent, {}), (error) => !/SOP 清单无效/.test(error.message))

  // A shell run that moved to the background has no exit code yet: the work
  // is not finished, so it must not count as an observed success.
  const bgCtx = makeCtx()
  const bgAgent = { id: 'agent-background' }
  await bgCtx.emitSkill(bgAgent, 'demo', dir)
  bgCtx.declare(bgAgent, { step: 'inspect' })
  bgCtx.emitResult(bgAgent, 'pwsh', false, { kind: 'background', jobId: 'job-1' })
  assert.throws(
    () => bgCtx.declare(bgAgent, { step: 'propose', evidence: '命令已启动为后台任务' }),
    /成功的工具执行记录/,
  )
  bgCtx.emitResult(bgAgent, 'pwsh', false, { kind: 'foreground', exitCode: 0 })
  assert.match(bgCtx.declare(bgAgent, { step: 'propose', evidence: '后台任务已结束，输出已读取' }), /第 2\/3 步/)

  // The verdict of a background run arrives later, in the job projection the
  // model collects with `job_output`. A settled job that exited zero is the
  // finished work of the shell run it belongs to.
  const jobCtx = makeCtx()
  const jobAgent = { id: 'agent-job' }
  await jobCtx.emitSkill(jobAgent, 'demo', dir)
  jobCtx.declare(jobAgent, { step: 'inspect' })
  jobCtx.emitResult(jobAgent, 'pwsh', false, { kind: 'background', jobId: 'job-2' })
  assert.throws(
    () => jobCtx.declare(jobAgent, { step: 'propose', evidence: '后台任务仍在跑，尚未结束' }),
    /成功的工具执行记录/,
  )
  jobCtx.emitResult(jobAgent, 'job_output', false, {
    text: 'done',
    job: { id: 'job-2', kind: 'pwsh', status: 'completed', detail: 'exit code: 0' },
  })
  assert.match(jobCtx.declare(jobAgent, { step: 'propose', evidence: '后台任务已结束，输出已读取' }), /第 2\/3 步/)

  // A background run that ended badly is not finished work either.
  const jobFailCtx = makeCtx()
  const jobFailAgent = { id: 'agent-job-fail' }
  await jobFailCtx.emitSkill(jobFailAgent, 'demo', dir)
  jobFailCtx.declare(jobFailAgent, { step: 'inspect' })
  jobFailCtx.emitResult(jobFailAgent, 'pwsh', false, { kind: 'background', jobId: 'job-3' })
  jobFailCtx.emitResult(jobFailAgent, 'job_output', false, {
    text: 'boom',
    job: { id: 'job-3', kind: 'pwsh', status: 'completed', detail: 'exit code: 1' },
  })
  assert.throws(
    () => jobFailCtx.declare(jobFailAgent, { step: 'propose', evidence: '后台任务已经结束，读取了输出' }),
    /成功的工具执行记录/,
  )

  // A shell that runs another shell hands the real command to the inner
  // shell, so the inner text is what the whitelist must match.
  const innerCtx = makeCtx()
  const innerAgent = { id: 'agent-inner' }
  const innerDir = await makeSkill({
    version: 1,
    steps: [{ id: 'run', title: '跑命令', tools: ['pwsh', 'bash'], commands: ['^git status$'] }],
  })
  dirs.push(innerDir)
  await innerCtx.emitSkill(innerAgent, 'inner', innerDir)
  innerCtx.declare(innerAgent, { step: 'run' })
  assert.equal(innerCtx.guard('pwsh', innerAgent, { command: 'pwsh -Command "git status"' }), undefined)
  assert.match(innerCtx.guard('pwsh', innerAgent, { command: 'pwsh -Command "git push"' }), /不在本步白名单内/)
  // A shell that reads its program from a file or from standard input runs
  // text the command line does not contain, so it cannot be cleared.
  assert.match(innerCtx.guard('pwsh', innerAgent, { command: 'pwsh -File build.ps1' }), /从文件或标准输入读命令/)
  assert.match(innerCtx.guard('bash', innerAgent, { command: 'bash build.sh' }), /从文件或标准输入读命令/)
  assert.match(
    innerCtx.guard('pwsh', innerAgent, { command: 'pwsh -Command "pwsh -Command \\"git status\\""' }),
    /套了太多层 shell/,
  )

  // A `witness` step is a reasoning-only step that must still be backed by a
  // real read: the model's word alone cannot advance it, but the read that
  // proves it is not something the step's own allowlist has to name.
  const witnessDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'review', title: '读依据', tools: [], witness: true },
      { id: 'write-it', title: '动手', tools: ['write'] },
    ],
  })
  dirs.push(witnessDir)
  const witnessCtx = makeCtx()
  const witnessAgent = { id: 'agent-witness' }
  await witnessCtx.emitSkill(witnessAgent, 'witnessed', witnessDir)
  witnessCtx.declare(witnessAgent, { step: 'review' })
  assert.throws(
    () => witnessCtx.declare(witnessAgent, { step: 'write-it', evidence: '已经审查过相关代码' }),
    /要求先真实读取依据/,
  )
  // A successful call that only looks busy is not a read. This is the bug a
  // live run found: a `pwsh echo` from the same step satisfied `witness`, so the
  // model could advance without ever opening the file it was asked to read.
  witnessCtx.emitResult(witnessAgent, 'pwsh', false, { kind: 'foreground', exitCode: 0 })
  assert.throws(
    () => witnessCtx.declare(witnessAgent, { step: 'write-it', evidence: '已经审查过相关代码' }),
    /要求先真实读取依据.*读取记录/,
  )
  // A read is not in the step's allowlist (it allows nothing), and it still
  // counts: the point of the step is that the evidence was actually looked at.
  witnessCtx.emitResult(witnessAgent, 'read', false, { content: [{ type: 'text', text: '…' }] })
  assert.match(witnessCtx.declare(witnessAgent, { step: 'write-it', evidence: '读完 src/main.ts 确认没有其它调用者' }), /第 2\/2 步/)
  // Without `witness`, a `tools: []` step is still advanceable on reasoning
  // alone: the field exists to opt in, not to change every reasoning step.
  const plainReasonDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'think', title: '想一想', tools: [] },
      { id: 'write-it', title: '动手', tools: ['write'] },
    ],
  })
  dirs.push(plainReasonDir)
  const plainReasonCtx = makeCtx()
  const plainReasonAgent = { id: 'agent-plain-reason' }
  await plainReasonCtx.emitSkill(plainReasonAgent, 'reasoned', plainReasonDir)
  plainReasonCtx.declare(plainReasonAgent, { step: 'think' })
  assert.match(plainReasonCtx.declare(plainReasonAgent, { step: 'write-it', evidence: '想清楚了方案再动手' }), /第 2\/2 步/)

  // An `approval` step is the one gate the model cannot pass by itself: only
  // a human typing /sop approve sets the flag, and it belongs to one step.
  const approvalDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'await-approval', title: '等人确认', tools: [], approval: true },
      { id: 'write-it', title: '动手', tools: ['write'] },
    ],
  })
  dirs.push(approvalDir)
  const approvalCtx = makeCtx()
  const approvalAgent = { id: 'agent-approval' }
  await approvalCtx.emitSkill(approvalAgent, 'approved-flow', approvalDir)
  approvalCtx.declare(approvalAgent, { step: 'await-approval' })
  assert.throws(
    () => approvalCtx.declare(approvalAgent, { step: 'write-it', evidence: '用户已经同意这个方案' }),
    /必须由用户运行 \/sop approve/,
  )
  assert.match(approvalCtx.stepContext(approvalAgent), /让用户运行 \/sop approve/)
  const sopCommand = approvalCtx.registered.find((entry) => entry.name === 'sop')
  assert.ok(sopCommand !== undefined, '/sop command must be registered')
  assert.match(
    sopCommand.handler({ agent: approvalAgent, rawInput: ' approve ' }).text,
    /已确认当前步骤/,
  )
  assert.match(approvalCtx.declare(approvalAgent, { step: 'write-it', evidence: '用户已确认，开始动手' }), /第 2\/2 步/)
  // Confirmation is per step: it must not carry into the next one.
  assert.match(
    sopCommand.handler({ agent: approvalAgent, rawInput: 'approve' }).text,
    /没有标 approval/,
  )
  // A flow without the field stays freely advanceable (opt-in, not global).
  const approvalExitCtx = makeCtx()
  const approvalExitAgent = { id: 'agent-approval-exit' }
  await approvalExitCtx.emitSkill(approvalExitAgent, 'approved-exit', approvalDir)
  approvalExitCtx.declare(approvalExitAgent, { step: 'await-approval' })
  assert.throws(
    () => approvalExitCtx.declare(approvalExitAgent, { step: 'done', evidence: '用户说不用继续了' }),
    /必须由用户运行 \/sop approve/,
  )
  const approvalExitSop = approvalExitCtx.registered.find((entry) => entry.name === 'sop')
  assert.match(
    approvalExitSop.handler({ agent: approvalExitAgent, rawInput: 'approve' }).text,
    /已确认当前步骤/,
  )
  assert.match(
    approvalExitCtx.declare(approvalExitAgent, { step: 'done', evidence: '用户说不用继续了' }),
    /没有生效中的 SOP 流程/,
  )

  const noApprovalDir = await makeSkill({
    version: 1,
    steps: [
      { id: 'think', title: '想一想', tools: [] },
      { id: 'write-it', title: '动手', tools: ['write'] },
    ],
  })
  dirs.push(noApprovalDir)
  const noApprovalCtx = makeCtx()
  const noApprovalAgent = { id: 'agent-no-approval' }
  await noApprovalCtx.emitSkill(noApprovalAgent, 'no-approval', noApprovalDir)
  noApprovalCtx.declare(noApprovalAgent, { step: 'think' })
  assert.match(
    noApprovalCtx.declare(noApprovalAgent, { step: 'write-it', evidence: '想清楚了方案再动手' }),
    /第 2\/2 步/,
  )

  // A checklist printed in a README is documentation only if it still parses
  // and still gates: a schema change that invalidates the example would
  // otherwise ship silently. Both languages carry the same example.
  for (const file of ['../README.md', '../README.en.md']) {
    const readme = readFileSync(new URL(file, import.meta.url), 'utf8')
    const example = /```json\r?\n([\s\S]*?)\r?\n```/.exec(readme)
    assert.ok(example !== null, `${file} must contain a json checklist example`)
    const readmeDir = await mkdtemp(join(tmpdir(), 'sop-guard-readme-'))
    dirs.push(readmeDir)
    await writeFile(join(readmeDir, 'SOP.json'), example[1], 'utf8')
    const readmeCtx = makeCtx()
    const readmeAgent = { id: 'agent-readme' }
    assert.deepEqual(await readmeCtx.emitSkill(readmeAgent, 'demo', readmeDir), [], `${file} must not be reported broken`)
    assert.match(readmeCtx.declare(readmeAgent, {}), /已装载流程：demo/)
    readmeCtx.declare(readmeAgent, { step: 'inspect' })
    readmeCtx.emitResult(readmeAgent, 'pwsh', false, { kind: 'foreground', exitCode: 0 })
    assert.match(readmeCtx.declare(readmeAgent, { step: 'review', evidence: '工作区干净，没有未提交改动' }), /已申报/)
    readmeCtx.declare(readmeAgent, { step: 'review' })
    assert.throws(
      () => readmeCtx.declare(readmeAgent, { step: 'await-approval', evidence: '看过了，可以开始改' }),
      /要求先真实读取依据/,
      `${file} documents witness, so the step must require a real read`,
    )
    readmeCtx.emitResult(readmeAgent, 'read', false, { content: [{ type: 'text', text: '…' }] })
    assert.match(readmeCtx.declare(readmeAgent, { step: 'await-approval', evidence: '读完 README 和 package.json' }), /已申报/)
    readmeCtx.declare(readmeAgent, { step: 'await-approval' })
    assert.throws(
      () => readmeCtx.declare(readmeAgent, { step: 'write', evidence: '方案已经给她看过了' }),
      /必须由用户运行 \/sop approve/,
      `${file} documents approval, so the step must wait for a human`,
    )
    const readmeSop = readmeCtx.registered.find((entry) => entry.name === 'sop')
    assert.match(
      readmeSop.handler({ agent: readmeAgent, rawInput: 'approve' }).text,
      /已确认当前步骤/,
    )
    assert.match(readmeCtx.declare(readmeAgent, { step: 'write', evidence: '她点头了，开始改' }), /已申报/)
  }

  // Both READMEs document the approval gate, so both examples must carry it.
  for (const file of ['../README.md', '../README.en.md']) {
    const readme = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(readme, /"approval": true/, `${file} must document the approval field`)
  }

  // The runnable example must match the structure each README prints. Titles
  // are translated in the English README, so compare the parsed checklist with
  // titles stripped: ids, tools, commands, witness and approval must be equal.
  const exampleSop = readFileSync(new URL('../examples/sop-demo/SOP.json', import.meta.url), 'utf8')
  const structure = (text) => {
    const doc = JSON.parse(text)
    return { version: doc.version, gatedTools: doc.gatedTools, steps: doc.steps.map(({ title, ...rest }) => rest) }
  }
  for (const file of ['../README.md', '../README.en.md']) {
    const readme = readFileSync(new URL(file, import.meta.url), 'utf8')
    const example = /```json\r?\n([\s\S]*?)\r?\n```/.exec(readme)
    assert.deepEqual(structure(example[1]), structure(exampleSop), `${file} example drifted from examples/sop-demo/SOP.json`)
  }
  const exampleSkill = readFileSync(new URL('../examples/sop-demo/SKILL.md', import.meta.url), 'utf8')
  assert.match(exampleSkill, /^---\r?\nname: sop-demo\r?\n/m, 'example skill must declare its name')
  assert.match(exampleSkill, /^description: \S/m, 'example skill must declare a description')
  const exampleDir = await mkdtemp(join(tmpdir(), 'sop-guard-example-'))
  dirs.push(exampleDir)
  await writeFile(join(exampleDir, 'SOP.json'), exampleSop, 'utf8')
  const exampleCtx = makeCtx()
  const exampleAgent = { id: 'agent-example' }
  assert.deepEqual(await exampleCtx.emitSkill(exampleAgent, 'sop-demo', exampleDir), [])
  assert.match(exampleCtx.declare(exampleAgent, {}), /已装载流程：sop-demo/)

  console.log('sop-guard: all checks passed')
} finally {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
}