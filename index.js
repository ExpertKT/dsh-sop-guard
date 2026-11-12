/**
 * SOP Guard: gate mutating tools against a skill's SOP.json step allowlist.
 *
 * Loading a skill whose directory holds SOP.json arms a flow for the session.
 * Each step declares the tools it allows and, for shell tools, a whitelist of
 * command patterns. The model declares the step it is on with `sop_step`; the
 * declaration lasts for the whole step (it is not consumed per call). Every
 * gated call is then checked against that step's allowlist, and a mismatch is
 * denied with a reason naming the step, the allowed tools/commands, the next
 * step and the checklist path.
 *
 * This is a step/command gate, not a semantic verifier: `evidence` is a
 * self-report, but advancing a step that declares tools also requires one
 * observed successful execution; a command's effects remain unobservable.
 * ponytail: a command must name a bare executable and match a declared
 * pattern; what that command then does is still unobservable.
 * Upgrade path: parse and validate against an OS-level command allowlist service.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'sop-guard'
export const inject = ['tools', 'systemPrompt', 'agents']

const SOP_FILE = 'SOP.json'
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,23}$/
const DONE = 'done'
const EVIDENCE_MIN = 8
const SHELL_TOOLS = ['pwsh', 'bash']
/** Tools that only look at things. A `witness` step needs one of these: any
 * successful call (say `pwsh echo hi`) used to satisfy it. A shell that reads is
 * still a shell, so it is listed only where it cannot write: the step's own
 * command allowlist decides that, and it is checked separately. */
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep']
/** Program transports: the payload is a program body, not a command line.
 * A program body is not split into shell segments and not matched against the
 * step's command patterns; the tools it calls are gated individually. */
const PROGRAM_TOOLS = ['run_code']
const FILE_TOOLS = ['write', 'edit', 'delete', 'move', 'copy', 'apply_patch']
const GATED_TOOLS = [...FILE_TOOLS, ...SHELL_TOOLS, ...PROGRAM_TOOLS]
/** Commands that change files on their own. A step that does not allow the
 * write/edit tools must not be able to reach the same effect through a shell
 * command, so these are refused on such a step. */
const FILE_COMMANDS = [
  'set-content', 'add-content', 'out-file', 'clear-content', 'new-item',
  'remove-item', 'copy-item', 'move-item', 'rename-item', 'export-csv',
  'rm', 'cp', 'mv', 'mkdir', 'touch', 'tee', 'dd',
]
/** Where the armed flow is persisted, so a resumed session keeps its place.
 * ponytail: one JSON file per session id; a shared store would need real
 * cross-process locking. Upgrade path: the session log itself. */
const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'sop-guard', 'flows')

/** `&` right after `>` belongs to a descriptor duplication, not to a separator. */
function isDescriptorJoin(char, previous) {
  return char === '&' && previous === '>'
}

const RULES = [
  '## SOP Guard',
  '有些 skill 目录里附带 SOP.json 流程清单：每一步声明允许的工具，shell 步骤必须声明命令白名单，否则该步的 shell 会被拒绝。加载这种 skill 后，改文件、删除、跑命令的工具会按当前步骤的白名单校验。',
  '开始每一步前调用 sop_step({"step":"<当前步骤 id>"}) 申报本步；申报对该步骤持续有效。申报下一步后，新的一步尚未申报，必须再调用一次 sop_step 申报它才能用工具。结束流程调用 sop_step({"step":"done","evidence":"..."})。结束与申报下一步都必须带 evidence（至少 8 个字符）；申报下一步时若本步声明了允许的工具，还需先有一次成功的工具执行记录。提前结束会记入主机日志。',
  '不给参数调用 sop_step 可查看当前流程、步骤与白名单；同时装载多个清单时用 sop_step({"skill":"<名称>"}) 切换生效的流程。被拒绝时的错误信息会写明原因、当前步骤、允许的工具/命令、下一步和清单位置。读取类工具不受限制。当前步骤也会出现在运行时上下文（Current runtime context）里；那份是权威的，拿不准自己在第几步时以它为准。',
  'run_code 的程序体同样受本步规则约束：程序体里出现 node:fs / node:child_process 等模块字面量时，若本步不允许改文件或有命令白名单，会被拒绝；要改文件、跑命令请用受管工具。标了 witness 的步骤不许改任何东西，但必须先用读取类工具看过依据（文件、日志、命令输出），再申报推进——只凭描述推进会被拒绝。标了 approval 的步骤要让用户运行 /sop approve 确认，你申报不了。清单写错或你不该再受它约束时，让用户运行 /sop off —— 只有用户能解除，你不要尝试绕过校验。',
].join('\n')


function isGateTool(toolName, sop) {
  return GATED_TOOLS.includes(toolName) || sop.gatedTools.includes(toolName)
}

/** Validate a parsed SOP document; unknown shapes are reported, never guessed. */
function parseSop(document, skillName) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { error: 'SOP 顶层必须是 JSON 对象' }
  }
  if (document.version !== 1) return { error: 'SOP version 必须为 1' }
  if (!Array.isArray(document.steps) || document.steps.length === 0) {
    return { error: 'SOP steps 必须是非空数组' }
  }
  const seen = new Set()
  const steps = []
  for (const [index, raw] of document.steps.entries()) {
    if (raw === null || typeof raw !== 'object') return { error: `第 ${index + 1} 个步骤不是对象` }
    const id = raw.id
    if (typeof id !== 'string' || !STEP_ID.test(id) || id === DONE) {
      return { error: `第 ${index + 1} 个步骤 id 非法或占用了保留字 "${DONE}"` }
    }
    if (seen.has(id)) return { error: `步骤 id "${id}" 重复` }
    seen.add(id)
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title.length === 0) return { error: `步骤 "${id}" 缺少 title` }
    const tools = raw.tools
    if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string'))) {
      return { error: `步骤 "${id}" 的 tools 必须是字符串数组` }
    }
    let commands
    if (raw.commands !== undefined) {
      if (!Array.isArray(raw.commands) || raw.commands.some((pattern) => typeof pattern !== 'string')) {
        return { error: `步骤 "${id}" 的 commands 必须是字符串数组` }
      }
      commands = []
      for (const pattern of raw.commands) {
        try {
          const regex = new RegExp(pattern)
          if (regex.test('') && regex.test('anything at all')) {
            // A pattern that matches every string is no whitelist at all.
            throw new Error('正则匹配所有内容，等于没有白名单')
          }
          commands.push({ source: pattern, regex })
        } catch (error) {
          return { error: `步骤 "${id}" 的 commands 正则 "${pattern}" 无效：${error.message}` }
        }
      }
    }
    const witness = raw.witness
    if (witness !== undefined && typeof witness !== 'boolean') {
      return { error: `步骤 "${id}" 的 witness 必须是布尔值` }
    }
    const approval = raw.approval
    if (approval !== undefined && typeof approval !== 'boolean') {
      return { error: `步骤 "${id}" 的 approval 必须是布尔值` }
    }
    steps.push({ id, title, tools, commands, witness: witness === true, approval: approval === true })
  }
  const extra = document.gatedTools
  if (extra !== undefined && (!Array.isArray(extra) || extra.some((tool) => typeof tool !== 'string'))) {
    return { error: 'gatedTools 必须是字符串数组' }
  }
  return { sop: { skill: skillName, steps, gatedTools: extra ?? [] } }
}

/** Load and parse the checklist next to a skill, if the skill ships one. */
async function loadSop(dir, skillName) {
  let text
  try {
    text = await readFile(join(dir, SOP_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'none' }
    return { kind: 'broken', reason: `读取失败：${error.message}` }
  }
  let document
  try {
    // A UTF-8 BOM is legal in a file but illegal to JSON.parse; editors on
    // Windows write one by default, so strip it before parsing.
    document = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { kind: 'broken', reason: `JSON 解析失败：${error.message}` }
  }
  const parsed = parseSop(document, skillName)
  if (parsed.error !== undefined) return { kind: 'broken', reason: parsed.error }
  return { kind: 'ready', sop: parsed.sop }
}

/** The parts of a flow that survive a process restart. Command patterns are
 * kept as their source text and recompiled, because a RegExp is not JSON. */
function flowToJson(flow) {
  return {
    dir: flow.dir,
    index: flow.index,
    declared: flow.declared,
    doneWork: flow.doneWork ?? 0,
    evidence: flow.evidence,
    observed: flow.observed ?? [],
    steps: flow.sop.steps.map((step) => ({
      id: step.id,
      title: step.title,
      tools: step.tools,
      commands: step.commands === undefined ? undefined : step.commands.map((entry) => entry.source),
      witness: step.witness === true,
      approval: step.approval === true,
    })),
  }
}

function flowFromJson(json) {
  const steps = []
  for (const step of json.steps ?? []) {
    let commands
    if (step.commands !== undefined) {
      commands = []
      for (const source of step.commands) {
        try {
          commands.push({ source, regex: new RegExp(source) })
        } catch {
          return undefined
        }
      }
    }
    steps.push({ id: step.id, title: step.title, tools: step.tools, commands, witness: step.witness === true, approval: step.approval === true })
  }
  if (steps.length === 0) return undefined
  return {
    dir: json.dir,
    sop: { skill: json.skill, steps, gatedTools: json.gatedTools ?? [] },
    index: json.index ?? 0,
    declared: json.declared === true,
    doneWork: json.doneWork ?? 0,
    evidence: json.evidence,
    observed: json.observed ?? [],
  }
}

/** Rename with a short retry: Windows rejects the replacement while another
 * handle (an indexer, a virus scanner, the previous read) is still open on the
 * target, and the handle clears within milliseconds. Without the retry a
 * perfectly good save is dropped and a resumed session rewinds a step. */
async function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const transient = error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES'
      if (!transient || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt))
    }
  }
}

/** Persist the armed flow so a resumed session continues where it stopped.
 * The write is atomic (temp file + rename) and guarded by a lock file, so two
 * processes restoring the same session cannot leave a half-written or
 * interleaved state behind. */
async function saveFlows(stateDir, key, state) {
  const payload = {
    skill: state.active,
    bySkill: Object.fromEntries([...state.bySkill].map(([name, flow]) => [name, flowToJson(flow)])),
  }
  const path = join(stateDir, `${key}.json`)
  const lock = join(stateDir, `${key}.lock`)
  let handle
  try {
    await mkdir(stateDir, { recursive: true })
    handle = await open(lock, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') {
      if (!(await isStaleLock(lock))) {
        // Another process owns this session's file: let it write, do not clobber.
        console.warn(`sop-guard: another process holds the flow file for "${key}"; skipped this write`)
        return
      }
      // The holder died without releasing the lock: take it over.
      await rm(lock, { force: true })
      try {
        handle = await open(lock, 'wx')
      } catch {
        console.warn(`sop-guard: another process holds the flow file for "${key}"; skipped this write`)
        return
      }
    } else {
      // Persistence is a convenience: a read-only home must not break the gate.
      console.warn(`sop-guard: cannot persist the armed flow for "${key}": ${error.message}`)
      return
    }
  }
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, JSON.stringify(payload), 'utf8')
    await renameWithRetry(temp, path)
  } catch (error) {
    console.warn(`sop-guard: cannot persist the armed flow for "${key}": ${error.message}`)
    await rm(temp, { force: true })
  } finally {
    await handle.close()
    await rm(lock, { force: true })
  }
}

/** A lock file whose holder is gone blocks every later write, so a lock older
 * than a few minutes is treated as abandoned. */
async function isStaleLock(lock) {
  try {
    const info = await stat(lock)
    return Date.now() - info.mtimeMs > 5 * 60 * 1000
  } catch {
    return true
  }
}

/** Restore a persisted flow, or undefined when there is nothing to restore. */
async function loadFlows(stateDir, key) {
  let text
  try {
    text = await readFile(join(stateDir, `${key}.json`), 'utf8')
  } catch {
    return undefined
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  const bySkill = new Map()
  for (const [name, json] of Object.entries(payload.bySkill ?? {})) {
    const flow = flowFromJson({ ...json, skill: name })
    if (flow !== undefined) bySkill.set(name, flow)
  }
  if (bySkill.size === 0) return undefined
  const active = bySkill.has(payload.skill) ? payload.skill : bySkill.keys().next().value
  return { active, bySkill }
}

/** Restore a persisted flow for a session id, checking the checklist is still
 * there: a persisted step that no longer exists in the file is not usable. */
async function restoreFlow(ctx, stateDir, key) {
  const state = await loadFlows(stateDir, key)
  if (state === undefined) return undefined
  for (const [name, flow] of state.bySkill) {
    // The step the session had reached, by id: an index alone cannot be
    // trusted once the checklist on disk may have changed.
    const reachedId = flow.sop.steps[flow.index]?.id
    const loaded = await loadSop(flow.dir, name)
    if (loaded.kind === 'ready') {
      const index = Math.min(flow.index, loaded.sop.steps.length - 1)
      const same = loaded.sop.steps[index]?.id === reachedId
      flow.sop = loaded.sop
      flow.index = same ? index : 0
      // A resumed session has not declared anything: the declaration belongs
      // to the step, and the model must make it again in the new process.
      flow.declared = false
      flow.doneWork = 0
      flow.observed = []
      if (!same) {
        flow.evidence = undefined
        ctx.logger?.warn?.(
          `sop-guard: the checklist for "${name}" changed while the session was away; restarted at step 1`,
        )
      }
      continue
    }
    // The checklist is gone or broken now: the persisted step cannot be trusted.
    state.bySkill.delete(name)
  }
  if (state.bySkill.size === 0) return undefined
  if (!state.bySkill.has(state.active)) state.active = state.bySkill.keys().next().value
  return state
}

/** Drop the persisted flow of a session that ended or was disposed. */
async function removeFlows(stateDir, key) {
  try {
    await rm(join(stateDir, `${key}.json`), { force: true })
  } catch {
    // Nothing to clean up, or the file is locked: the next write replaces it.
  }
}

/** Whether a tool call failed. The shell tools report a non-zero exit code as
 * a successful call carrying a report, so the exit code is the only signal
 * there; other tools may put the failure somewhere else in the value, so a few
 * common shapes are checked too. */
function isFailedResult(exec, result) {
  const value = result?.value
  if (value?.timedOut === true || value?.aborted === true) return true
  // A generic failure shape counts wherever it shows up, shell tools included.
  if (value?.ok === false || value?.success === false) return true
  if (typeof value?.error === 'string' && value.error !== '') return true
  if (SHELL_TOOLS.includes(exec.name)) {
    if (typeof value?.signal === 'string' && value.signal !== '') return true
    return typeof value?.exitCode === 'number' && value.exitCode !== 0
  }
  return false
}

/** Whether a shell call is still running instead of finished. A background run
 * returns a job id and a promoted run says the command was moved to the
 * background: neither carries an exit code, so the work is not observable yet
 * and must not count as a finished step. */
function isUnsettledResult(exec, result) {
  if (!SHELL_TOOLS.includes(exec.name)) return false
  const kind = result?.value?.kind
  return kind === 'background' || kind === 'promoted'
}

/** How a background job ended, as far as the job projection shows it. The
 * terminal reason travels in `detail`: a settled shell process reports
 * `exit code: N` and a killed one reports `signal: ...`. A job still running
 * has no verdict yet. */
function jobOutcome(job) {
  const status = typeof job?.status === 'string' ? job.status : ''
  if (status === 'running' || status === 'stopping') return 'pending'
  if (status === 'killed' || status === 'failed') return 'failed'
  if (status !== 'completed') return undefined
  const detail = typeof job.detail === 'string' ? job.detail : ''
  const match = /exit code: (-?\d+)/.exec(detail)
  if (match === null) return 'failed'
  return match[1] === '0' ? 'ok' : 'failed'
}

function listAllowed(step, sop) {
  const tools = step.tools ?? [...GATED_TOOLS, ...sop.gatedTools]
  return tools.length === 0 ? '(无)' : tools.join(', ')
}

function isToolAllowed(step, toolName) {
  if (step.tools === undefined) return true
  if (step.tools.includes(toolName)) return true
  // A program transport carries the tools it calls; every nested call is gated
  // on its own, so the transport stays usable whenever the step allows any
  // tool at all. Denying it would strand a model that can only call through
  // the transport.
  return PROGRAM_TOOLS.includes(toolName) && step.tools.length > 0
}

/** Whether a successful call counts as the work this step needed.
 * A `witness` step reads its evidence instead of changing anything, so only a
 * read counts: any successful call let `pwsh echo hi` satisfy it. A step that
 * names its own tools may still count them — the author opted in. */
function isCommittable(step, toolName) {
  if (step.witness !== true) return isToolAllowed(step, toolName)
  if (READ_TOOLS.includes(toolName)) return true
  return isToolAllowed(step, toolName) && (step.tools?.length ?? 0) > 0
}

/** Split a command line into segments, honouring quotes.
 * A `;`, `&`, `|` or newline inside quotes is part of the quoted text, not a
 * separator, so the split has to track quoting instead of slicing blindly. */
function splitShellSegments(raw) {
  const segments = []
  let current = ''
  let quote = null
  let previous = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote !== null) {
      // Inside double quotes a backslash escapes the next character, so an
      // escaped quote does not close the string.
      if (quote === '"' && char === '\\' && index + 1 < raw.length) {
        current += char + raw[index + 1]
        previous = raw[index + 1]
        index += 1
        continue
      }
      current += char
      if (char === quote) quote = null
      previous = char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      previous = char
      continue
    }
    if (isDescriptorJoin(char, previous)) {
      current += char
      previous = char
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n') {
      segments.push(current)
      current = ''
      previous = ''
      continue
    }
    current += char
    previous = char
  }
  segments.push(current)
  return {
    segments: segments.map((part) => part.trim()).filter((part) => part !== ''),
    unterminated: quote !== null,
  }
}

/** Scan one command segment into tokens and flag the structures a regex
 * allowlist cannot prove safe. Quoting rules follow POSIX shells and
 * PowerShell: single quotes are literal, double quotes still expand `$` and
 * backticks, so only text that actually expands can carry a command
 * substitution. `>&` only duplicates a descriptor; `>` and `<` touch files. */
function scanSegment(segment) {
  const tokens = []
  let text = ''
  let quote = null
  let expansion = false
  let redirect = false
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (quote === "'") {
      if (char === "'") quote = null
      else text += char
      continue
    }
    if (quote === '"') {
      if (char === '\\' && index + 1 < segment.length) {
        // Inside double quotes a backslash escapes the next character, so an
        // escaped quote does not close the string.
        text += char + segment[index + 1]
        index += 1
        continue
      }
      if (char === '"') quote = null
      else {
        // Inside double quotes `$` still expands, and a variable can change
        // which command runs, so any `$` is an expansion we cannot verify.
        if (char === '`' || char === '$') expansion = true
        text += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '`') {
      expansion = true
      text += char
      continue
    }
    if (char === '$' && (segment[index + 1] === '(' || segment[index + 1] === '{')) {
      expansion = true
      text += char
      continue
    }
    if (char === '>' && segment[index + 1] === '&') {
      text += char
      continue
    }
    if (char === '>' || char === '<') {
      redirect = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (text !== '') {
        tokens.push(text)
        text = ''
      }
      continue
    }
    text += char
  }
  if (text !== '') tokens.push(text)
  return { tokens, expansion, redirect, unterminated: quote !== null }
}

/** Split a segment into raw tokens, quotes kept, so a command line can be
 * handed to another shell exactly as it was written. */
function rawTokens(segment) {
  const tokens = []
  let current = ''
  let quote = null
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (quote !== null) {
      if (quote === '"' && char === '\\' && index + 1 < segment.length) {
        current += char + segment[index + 1]
        index += 1
        continue
      }
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** The command a shell flag carries is one quoted string: `pwsh -Command "git
 * status"` hands `git status` to the inner shell. Unwrap that one layer so the
 * inner text can be read as it was written. */
function stripOneQuoteLayer(text) {
  const trimmed = text.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["'`\\$])/g, '$1')
  }
  return trimmed
}

/** The command as the shell would see it: tokens joined by single spaces.
 * `git 'status'` runs `git status`, so an allowlist written for the command
 * must accept the spelling too. */
function canonicalCommand(tokens) {
  return tokens.map((token) => token.trim()).filter((token) => token !== '').join(' ')
}

/** Return the first command segment that no declared pattern allows. */
function findCommandDenial(step, exec) {
  if (!SHELL_TOOLS.includes(exec.name)) return undefined
  // A step that allows a shell must say which commands it allows. Without a
  // whitelist there is nothing to check a command against, so the command is
  // refused instead of run unchecked. A step that declares no tools at all is
  // unrestricted on purpose and keeps its shell.
  if (step.commands === undefined) {
    const declared = step.tools ?? []
    if (declared.length === 0) return undefined
    if (!declared.some((tool) => SHELL_TOOLS.includes(tool))) return undefined
    return '本步允许 shell 但未声明命令白名单，命令内容无法核验'
  }
  const raw = exec.arguments?.command
  if (typeof raw !== 'string' || raw.trim() === '') return '无法读取命令内容，不能按白名单校验'
  const { segments, unterminated } = splitShellSegments(raw)
  if (unterminated) return '命令里有未闭合的引号，无法按白名单核验'
  return checkSegments(segments, step)
}

/** Check every command segment of a command line against the step's patterns.
 * A shell that runs another command (`pwsh -Command "git status"`) hands the
 * real command to the inner shell, so the inner text is checked as well: a
 * pattern that names the outer shell must not let it run anything. */
function checkSegments(segments, step, depth = 0) {
  for (const segment of segments) {
    const scan = scanSegment(segment)
    if (scan.unterminated) return '命令里有未闭合的引号，无法按白名单核验'
    if (scan.expansion) {
      return `命令片段 "${segment}" 含有命令替换等无法用白名单核验的结构`
    }
    if (scan.redirect) {
      return `命令片段 "${segment}" 含有重定向等无法用白名单核验的结构`
    }
    if (!isBareExecutable(scan.tokens[0])) {
      return `命令片段 "${segment}" 必须直接调用程序名，不能用路径调用`
    }
    if (scan.tokens.slice(1).some((token) => ENCODED_FLAGS.includes(token.toLowerCase()))) {
      return `命令片段 "${segment}" 用了编码命令，内容无法核验`
    }
    const program = (scan.tokens[0] ?? '').toLowerCase()
    let inner = false
    if (SHELL_PROGRAMS.includes(program)) {
      if (depth >= 1) {
        // A shell inside a shell adds another layer of quoting. The plain
        // reading of the outer text can no longer be trusted, so the command
        // cannot be cleared.
        return `命令片段 "${segment}" 套了太多层 shell，命令内容无法核验`
      }
      const flags = COMMAND_FLAGS[program] ?? []
      const flagAt = scan.tokens.findIndex(
        (token, index) => index > 0 && flags.includes(token.toLowerCase()),
      )
      if (flagAt < 0) {
        // The shell takes its program from a file or from standard input:
        // the text that runs is not in the command line and cannot be read.
        return `命令片段 "${segment}" 让 ${program} 从文件或标准输入读命令，命令内容无法核验`
      }
      const text = stripOneQuoteLayer(rawTokens(segment).slice(flagAt + 1).join(' '))
      const split = splitShellSegments(text)
      if (split.unterminated) return '命令里有未闭合的引号，无法按白名单核验'
      if (split.segments.length === 0) {
        return `命令片段 "${segment}" 没有给出要执行的命令，命令内容无法核验`
      }
      if (depth >= 2) {
        return `命令片段 "${segment}" 套了太多层 shell，命令内容无法核验`
      }
      inner = true
      const denial = checkSegments(split.segments, step, depth + 1)
      if (denial !== undefined) return denial
    }
    const mutators = fileMutators(scan.tokens)
    for (const mutator of mutators) {
      if (!stepAllowsFileChange(step) && !patternNamesMutator(step, mutator)) {
        return `命令片段 "${segment}" 用 ${mutator} 改文件，但本步不允许 write/edit 等改文件的工具`
      }
    }
    if (inner) continue
    // Match the spelling the model typed and the command the shell runs:
    // quoting only changes how an argument is delimited, not the command.
    const canonical = canonicalCommand(scan.tokens)
    if (!step.commands.some((entry) => entry.regex.test(segment) || entry.regex.test(canonical))) {
      return `命令片段 "${segment}" 不在本步白名单内`
    }
  }
  return undefined
}

/** The program a segment runs has to be named plainly: a path can point at
 * any file, so a pattern that allows it allows the wrong program too. */
function isBareExecutable(token) {
  if (token === undefined || token === '') return false
  if (token === '.' || token === '..') return false
  return !token.includes('/') && !token.includes('\\')
}

/** The shells that take a command line as a flag argument, per program. A
 * `-c` on another program means something else (a git config key, for one),
 * so the program decides which flags carry a command. */
const COMMAND_FLAGS = {
  pwsh: ['-command', '-c'],
  powershell: ['-command', '-c'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  cmd: ['/c'],
}
/** The programs that are shells: they run a command line, either from a flag
 * argument, a script file or the standard input. Only the first form can be
 * read and matched against a pattern. */
const SHELL_PROGRAMS = Object.keys(COMMAND_FLAGS)
/** The flag whose argument is a command line encoded as base64, so its text
 * cannot be read at all. */
const ENCODED_FLAGS = ['-encodedcommand', '-enc']
/** Node modules a program body can use to change files or run commands
 * without going through a gated tool. The step's rules are about the tools
 * and commands it allows, so a program body must not reach the same effects
 * on the side. */
const PROGRAM_FILE_MODULES = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises']
const PROGRAM_EXEC_MODULES = ['node:child_process', 'child_process']

/** The file-writing commands a command line mentions. A shell runs the string
 * it is handed, so `pwsh -Command "Remove-Item x"` writes files even though
 * the program name is `pwsh`. Only that argument is scanned: an unrelated
 * argument that happens to contain a writer name is not a command. */
function fileMutators(tokens) {
  const found = []
  const add = (name) => {
    if (!found.includes(name)) found.push(name)
  }
  const program = (tokens[0] ?? '').toLowerCase()
  if (FILE_COMMANDS.includes(program)) add(program)
  const flags = COMMAND_FLAGS[program] ?? []
  const flagAt = tokens.findIndex(
    (token, index) => index > 0 && flags.includes(token.toLowerCase()),
  )
  if (flagAt >= 0) {
    const inner = tokens.slice(flagAt + 1).join(' ')
    for (const part of inner.toLowerCase().split(/[^a-z0-9-]+/)) {
      if (FILE_COMMANDS.includes(part)) add(part)
    }
  }
  return found
}

/** Whether the step may change files through the file tools. A step that names
 * a shell but no file tool must not reach the same effect through a shell
 * command, unless its whitelist names that command explicitly. */
function stepAllowsFileChange(step) {
  if (step.tools === undefined) return true
  return step.tools.some((tool) => FILE_TOOLS.includes(tool))
}

/** Whether a command pattern names the file-writing command on purpose. */
function patternNamesMutator(step, mutator) {
  if (step.commands === undefined) return false
  return step.commands.some((entry) => entry.source.toLowerCase().includes(mutator))
}

/** The quoted literals in a program body. A module name can sit in a variable
 * (`const m = "node:fs"; await import(m)`) or be handed to require(),
 * process.getBuiltinModule() or process.binding(), so matching import syntax
 * alone would miss it. Every quoted literal is checked against the blocked
 * module names instead. */
function programLiterals(code) {
  const found = new Set()
  const pattern = /['"`]([^'"`]+)['"`]/g
  let match = pattern.exec(code)
  while (match !== null) {
    found.add(match[1])
    match = pattern.exec(code)
  }
  return found
}

/** Whether a program body reaches past the step's rules: the file modules
 * change files without the file tools, the process module runs commands
 * without the command patterns. */
function findProgramDenial(step, exec) {
  if (!PROGRAM_TOOLS.includes(exec.name)) return undefined
  const code = exec.arguments?.code
  if (typeof code !== 'string' || code === '') return undefined
  for (const name of programLiterals(code)) {
    if (PROGRAM_FILE_MODULES.includes(name)) {
      if (!stepAllowsFileChange(step)) {
        return `程序体引入了 ${name}，可以绕过本步的 write/edit 等改文件的工具`
      }
      continue
    }
    if (PROGRAM_EXEC_MODULES.includes(name) && step.tools !== undefined) {
      return `程序体引入了 ${name}，可以绕过本步的命令白名单`
    }
  }
  return undefined
}

function listPatterns(step) {
  return step.commands === undefined ? '' : `本步命令白名单：${step.commands.map((entry) => entry.source).join(' | ')}。`
}

function hasUncheckedShell(step) {
  // A step without `tools` is unrestricted on purpose; only a step that names
  // a shell but no command list is refused.
  if (step.tools === undefined) return false
  return step.commands === undefined && step.tools.some((tool) => SHELL_TOOLS.includes(tool))
}

function buildDenial(flow, reason) {
  const { sop, index } = flow
  const step = sop.steps[index]
  const next = sop.steps[index + 1]
  const lines = [
    `SOP 未通过检测：流程「${sop.skill}」第 ${index + 1}/${sop.steps.length} 步「${step.title}」（id: ${step.id}）。`,
    `原因：${reason}`,
  ]
  if (!flow.declared) lines.push(`必须先调用 sop_step({"step":"${step.id}"}) 申报本步，再用被拦的工具重试。`)
  lines.push(`本步允许：${listAllowed(step, sop)}。`)
  if (step.commands !== undefined) lines.push(listPatterns(step))
  else if (hasUncheckedShell(step)) lines.push('本步允许 shell 但未声明 commands，该步的 shell 调用会被拒绝。')
  if (step.witness === true && (flow.doneWork ?? 0) === 0) {
    lines.push('本步标了 witness：先读文件/日志/命令输出（读取类工具不受白名单限制），再申报推进。')
  }
  if (step.approval === true && flow.approved !== true) {
    lines.push('本步标了 approval：让用户运行 /sop approve 确认后，你才能申报推进。')
  }
  if (next !== undefined) {
    lines.push(`下一步「${next.title}」（id: ${next.id}）；申报下一步需带 evidence 说明本步结果。`)
  }
  lines.push('结束本流程：sop_step({"step":"done","evidence":"..."})；切换流程：sop_step({"skill":"<名称>"})；不给参数调用 sop_step 可查看当前状态。')
  lines.push(`流程清单：${join(flow.dir, SOP_FILE)}`)
  return lines.join('\n')
}

function requireEvidence(args, kind) {
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : ''
  if (evidence.length < EVIDENCE_MIN) {
    throw new Error(`${kind}必须给 evidence（至少 ${EVIDENCE_MIN} 个字符）：说明本步为什么已经完成或中止。`)
  }
  return evidence
}

function requireApproval(flow, kind) {
  const step = flow.sop.steps[flow.index]
  // `approval` is the one thing the model cannot produce on its own: only a
  // human typing /sop approve sets this flag. ponytail: it lives in memory on
  // purpose, so a resumed session asks the human again instead of inheriting
  // a confirmation nobody watched happen.
  if (step.approval === true && flow.approved !== true) {
    throw new Error(
      `本步「${step.id}」标了 approval：必须由用户运行 /sop approve 确认，模型不能自己${kind}；本次拒绝没有副作用。`,
    )
  }
}

function requireObservedWork(flow, kind) {
  const step = flow.sop.steps[flow.index]
  // `tools: []` is an explicit reasoning-only step; a missing `tools` means
  // unrestricted, which must still be backed by one observed tool run. A
  // `witness` step also allows no mutating tool, but it must not be advanced
  // on the model's word alone: something had to be read first.
  const needsWork = step.tools === undefined || step.tools.length > 0 || step.witness === true
  if (needsWork && (flow.doneWork ?? 0) === 0) {
    const why = step.witness === true
      ? `本步「${step.id}」要求先真实读取依据（witness），但还没有任何成功的读取记录（read / glob / grep）`
      : `本步「${step.id}」声明了允许的工具（${listAllowed(step, flow.sop)}），但还没有任何成功的工具执行记录`
    throw new Error(`${why}：先在本步真正执行工作，再${kind}；本次拒绝没有副作用。`)
  }
}

/** What the host actually saw: one entry per successful tool call, in order.
 * The model's `evidence` is a self-report; this is the observation next to
 * it, so an audit can compare what was claimed with what was run. */
function observedSummary(flow) {
  const observed = flow.observed ?? []
  if (observed.length === 0) return '(无)'
  const counts = new Map()
  for (const entry of observed) counts.set(entry, (counts.get(entry) ?? 0) + 1)
  return [...counts].map(([tool, count]) => `${tool} ×${count}`).join(', ')
}

function auditAdvance(ctx, flow, kind, evidence) {
  ctx.logger.warn(
    `sop-guard: flow "${flow.sop.skill}" ${kind} at step ${flow.index + 1}/${flow.sop.steps.length}` +
      ` (${flow.sop.steps[flow.index].id}); model evidence: ${evidence}; observed tool runs: ${observedSummary(flow)}`,
  )
}

function renderStatus(state, pending = []) {
  if (state === undefined || state.active === null) {
    if (pending.length > 0) return `当前会话没有生效中的 SOP 流程。\n${pending.join('\n')}`
    return '当前会话没有生效中的 SOP 流程。'
  }
  const flow = state.bySkill.get(state.active)
  const step = flow.sop.steps[flow.index]
  const next = flow.sop.steps[flow.index + 1]
  const loaded = [...state.bySkill.keys()]
    .map((name) => (name === state.active ? `${name}(生效中)` : name))
    .join(', ')
  const lines = [
    `已装载流程：${loaded}。`,
    `当前流程「${flow.sop.skill}」第 ${flow.index + 1}/${flow.sop.steps.length} 步「${step.title}」（id: ${step.id}）：${flow.declared ? '本步已申报' : '本步尚未申报'}。`,
    `本步允许：${listAllowed(step, flow.sop)}。`,
  ]
  if ((flow.doneWork ?? 0) > 0) lines.push(`本步已观察到 ${flow.doneWork} 次成功的工具执行：${observedSummary(flow)}。`)
  if (step.witness === true && (flow.doneWork ?? 0) === 0) lines.push('本步标了 witness：先用读取类工具看过依据，才能申报推进。')
  if (step.approval === true) lines.push(flow.approved === true ? '本步标了 approval：用户已确认。' : '本步标了 approval：等用户运行 /sop approve 确认。')
  if (step.commands !== undefined) lines.push(listPatterns(step))
  else if (hasUncheckedShell(step)) lines.push('本步允许 shell 但未声明 commands，该步的 shell 调用会被拒绝。')
  if (flow.evidence !== undefined) lines.push(`上一步申报依据：${flow.evidence}`)
  if (next !== undefined) lines.push(`下一步「${next.title}」（id: ${next.id}）。`)
  else lines.push('已是最后一步；完成后调用 sop_step({"step":"done","evidence":"..."}) 结束流程。')
  for (const notice of pending) lines.push(notice)
  return lines.join('\n')
}

/** The anti-forgetting broadcast: one line saying where the model is, which
 * step it must declare, and what that step allows. The framework re-projects
 * this as a fresh user message whenever it changes, so a model that lost the
 * `sop_step` result deep in the context still sees its position before the
 * next call. Empty text means no broadcast (no flow, or none armed). */
function renderStepContext(state) {
  if (state === undefined || state.active === null) return ''
  const flow = state.bySkill.get(state.active)
  if (flow === undefined) return ''
  const step = flow.sop.steps[flow.index]
  const next = flow.sop.steps[flow.index + 1]
  const parts = [
    `SOP 流程「${flow.sop.skill}」第 ${flow.index + 1}/${flow.sop.steps.length} 步「${step.title}」（id: ${step.id}）`,
    flow.declared ? '本步已申报' : `本步尚未申报：先调用 sop_step({"step":"${step.id}"})`,
    `本步允许：${listAllowed(step, flow.sop)}`,
  ]
  if (step.witness === true) {
    parts.push((flow.doneWork ?? 0) > 0 ? '本步要求先读取依据（已观察到读取）' : '本步要求先读取依据：先读文件/日志/命令输出，再申报')
  }
  if (step.approval === true) {
    parts.push(flow.approved === true ? '本步要求用户确认（已确认）' : '本步要求用户确认：让用户运行 /sop approve')
  }
  if (step.commands !== undefined) parts.push(`本步命令白名单：${step.commands.map((entry) => entry.source).join(' | ')}`)
  else if (hasUncheckedShell(step)) parts.push('本步允许 shell 但未声明 commands，该步的 shell 调用会被拒绝')
  if (next !== undefined) parts.push(`下一步「${next.title}」（id: ${next.id}）`)
  else parts.push('已是最后一步；完成后调用 sop_step({"step":"done","evidence":"..."}) 结束流程')
  return `${parts.join('；')}。`
}

/** Copy an armed flow from the agent that owns a newly created one.
 * A sub agent works under the same checklist as its parent: it must still
 * declare the step itself, but it must not be able to escape the parent's
 * flow by running in its own session. */
function inheritFlow(ctx, agent, sessions) {
  if (agent?.id === undefined) return
  const key = String(agent.id)
  if (sessions.has(key)) return
  const inherited = findInherited(ctx, key, sessions)
  if (inherited === undefined) return
  sessions.set(key, inherited.state)
  ctx.logger.warn(`sop-guard: agent "${key}" inherited the armed SOP flow "${inherited.state.active}" from "${inherited.parentKey}"`)
}

/** Walk up the ownership chain to the nearest ancestor that has an armed flow.
 * The chain is found by asking every known agent whether it owns the session
 * below it, because the agent service exposes ownership but not the parent
 * directly. */
function findInherited(ctx, key, sessions) {
  const agents = ctx.agents
  if (agents === undefined) return undefined
  const seen = new Set()
  let currentKey = key
  while (!seen.has(currentKey)) {
    seen.add(currentKey)
    let parent
    try {
      for (const candidate of agents.list()) {
        if (String(candidate.id) === currentKey) continue
        if (agents.isOwnedBy(currentKey, candidate)) {
          parent = candidate
          break
        }
      }
    } catch {
      return undefined
    }
    if (parent === undefined) return undefined
    const parentKey = String(parent.id)
    const parentState = sessions.get(parentKey)
    if (parentState !== undefined && parentState.active !== null) {
      const bySkill = new Map()
      for (const [name, flow] of parentState.bySkill) {
        bySkill.set(name, {
          ...flow,
          // The child has not declared anything yet: inheritance arms the same
          // checklist, it does not grant the permission to use tools, and it
          // does not carry over a confirmation given to another agent.
          declared: false,
          observed: [],
          approved: false,
        })
      }
      return { parentKey, state: { active: parentState.active, bySkill, inherited: true } }
    }
    currentKey = parentKey
  }
  return undefined
}

/** The session's own flow, or the one its parent is under. A sub agent that
 * was created before the parent armed its checklist would otherwise run with
 * no gate at all, so the ancestor is looked up on every call instead of only
 * when the agent was announced. */
function resolveSession(ctx, agent, sessions) {
  if (agent?.id === undefined) return undefined
  const key = String(agent.id)
  const own = sessions.get(key)
  if (own !== undefined) return own
  const inherited = findInherited(ctx, key, sessions)
  if (inherited === undefined) return undefined
  sessions.set(key, inherited.state)
  ctx.logger.warn(`sop-guard: agent "${key}" inherited the armed SOP flow "${inherited.state.active}" from "${inherited.parentKey}"`)
  return inherited.state
}

export function apply(ctx, config) {
  if (config?.mode !== undefined && config.mode !== 'enforce' && config.mode !== 'warn') {
    throw new Error(`sop-guard: mode must be "enforce" or "warn" (got ${JSON.stringify(config.mode)})`)
  }
  const mode = config?.mode === 'warn' ? 'warn' : 'enforce'
  // Persistence is opt-out: `stateDir: false` keeps the flow in memory only.
  const stateDir = config?.stateDir === false ? undefined : (config?.stateDir ?? DEFAULT_STATE_DIR)
  // Session state belongs to this plugin instance, not the imported module:
  // HMR re-apply or a second Cordis context must not share another one's flow.
  const sessions = new Map()
  // Notices the model has not seen yet, per session: a broken checklist must
  // not be lost when the model does not read the turn it was raised in.
  const notices = new Map()
  // Agents that were disposed, mapped to the exact instance that died. A
  // resumed session reuses the id but not the instance, so the id alone cannot
  // decide "this agent is gone".
  const retired = new Map()
  const promptOrder = (() => {
    try {
      return ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 1
    } catch {
      return 60
    }
  })()
  // Static text: the live step lives in sop_step results and denial reasons,
  // so advancing a step never changes the system-prompt prefix (KV cache).
  ctx.systemPrompt.section({ name: 'sop-guard', order: promptOrder, text: RULES })
  // The live step is broadcast as runtime context instead of living only in
  // results: a model whose attention drifted off the checklist gets its
  // position re-stated before the next call. The framework keeps the system
  // prompt untouched and only re-projects this when the text actually changes,
  // so it costs nothing while the step stays put.
  ctx.systemPrompt.context({
    name: 'sop-guard:step',
    order: 130,
    text: (context) => {
      const agent = context.agent
      if (agent?.id === undefined) return ''
      return renderStepContext(resolveSession(ctx, agent, sessions))
    },
  })

  // Human-facing status: the command registry is the surface a user can reach
  // without the model. It reads the same state the gate uses.
  const commands = ctx.get?.('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      definitionId: 'dsh-sop-guard',
      name: 'sop',
      description: 'Show the armed SOP flow; "/sop approve" confirms an approval step; "/sop off" disarms it for this session',
      handler: (invocation) => {
        const state = invocation.agent === undefined
          ? undefined
          : resolveSession(ctx, invocation.agent, sessions)
        // The model can declare a step, but only a human at the keyboard can
        // confirm one. This is a distinct action from /sop off: approving
        // keeps the flow armed and lets the model advance exactly one step.
        if ((invocation.rawInput ?? '').trim() === 'approve') {
          if (state === undefined || state.active === null) {
            return { kind: 'success', text: '当前会话没有生效中的 SOP 流程。' }
          }
          const flow = state.bySkill.get(state.active)
          const step = flow.sop.steps[flow.index]
          if (step.approval !== true) {
            return { kind: 'success', text: `当前步骤「${step.id}」没有标 approval，不需要确认。` }
          }
          if (flow.approved === true) {
            return { kind: 'success', text: `当前步骤「${step.id}」已经确认过了。` }
          }
          flow.approved = true
          ctx.logger.warn(`sop-guard: flow "${state.active}" step ${flow.index + 1} (${step.id}) approved by the user ("/sop approve")`)
          persist(String(invocation.agent.id))
          return { kind: 'success', text: `已确认当前步骤「${step.title}」（id: ${step.id}）。模型现在可以申报下一步。` }
        }
        // A checklist that is wrong, or a model stuck against it, must not be
        // something only the model can escape: the human typing here owns the
        // session. Disarming is the escape hatch, and it is audited.
        if ((invocation.rawInput ?? '').trim() === 'off') {
          const key = invocation.agent?.id === undefined ? undefined : String(invocation.agent.id)
          if (key === undefined || state === undefined || state.active === null) {
            return { kind: 'success', text: '当前会话没有生效中的 SOP 流程。' }
          }
          const names = [...state.bySkill.keys()].join(', ')
          ctx.logger.warn(`sop-guard: flow "${state.active}" disarmed by the user ("/sop off"); flows dropped: ${names}`)
          sessions.delete(key)
          notices.delete(key)
          forget(key)
          return { kind: 'success', text: `已解除本会话的 SOP 流程（${names}）。模型不再受步骤校验；重新调用 skill 工具加载清单可再次武装。` }
        }
        return { kind: 'success', text: renderStatus(state) }
      },
    })
  }

  /** Persist the flow after every change, so a resumed session keeps its place.
   * Writes are chained per session: two overlapping writes would otherwise
   * land out of order and leave an older flow on disk. */
  const writes = new Map()
  const enqueue = (key, task) => {
    const previous = writes.get(key) ?? Promise.resolve()
    const next = previous.then(task)
    writes.set(key, next.catch(() => {}))
  }
  const persist = (key) => {
    if (stateDir === undefined) return
    const state = sessions.get(key)
    if (state === undefined) return
    enqueue(key, () => saveFlows(stateDir, key, state))
  }
  /** Deleting the flow file is a write too: it must queue behind any save that
   * is still in flight, or that save lands afterwards and revives the flow a
   * resumed session then re-arms. */
  const forget = (key) => {
    if (stateDir === undefined) return
    enqueue(key, () => removeFlows(stateDir, key))
  }

  ctx.tools.register({
    name: 'sop_step',
    description:
      '查看或申报当前 SOP 流程：不给参数返回当前流程、步骤与允许的工具/命令；给 step 申报当前步骤或它的下一步（申报下一步会自动推进，必须带 evidence；本步声明了工具时还需先有成功的工具执行；标了 approval 的步骤还要用户先运行 /sop approve；推进后新的一步需要单独申报）；step 为 "done" 结束流程；给 skill 切换生效的流程。申报对该步骤持续有效，不按工具调用次数消耗。',
    parameters: {
      type: 'object',
      properties: {
        step: { type: 'string', description: '当前或下一步的 id；填 "done" 结束流程；省略则只查询状态' },
        skill: { type: 'string', description: '可选：切换到已装载的另一个流程' },
        action: { type: 'string', description: '可选：接下来要用的工具名，提前校验本步是否允许' },
        evidence: { type: 'string', description: '申报下一步时必填：上一步观察到的结果，至少 8 个字符' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      const id = exec.agent?.id
      const state = id === undefined ? undefined : resolveSession(ctx, exec.agent, sessions)
      if (state === undefined) {
        const pending = notices.get(String(id)) ?? []
        const suffix = pending.length > 0 ? `\n${pending.join('\n')}` : ''
        // The model has seen the notices now; they do not need repeating.
        if (pending.length > 0) notices.delete(String(id))
        throw new Error(`当前会话没有已装载的 SOP：先调用 skill 工具加载带 SOP.json 的 skill。${suffix}`)
      }
      if (typeof args.skill === 'string') {
        if (!state.bySkill.has(args.skill)) {
          throw new Error(`流程「${args.skill}」尚未装载：已装载 ${[...state.bySkill.keys()].join(', ')}。`)
        }
        state.active = args.skill
        persist(String(id))
      }
      if (args.step === DONE) {
        if (state.active !== null) {
          const flow = state.bySkill.get(state.active)
          const reason = requireEvidence(args, '提前结束流程')
          requireApproval(flow, '提前结束流程')
          const last = flow.index === flow.sop.steps.length - 1
          ctx.logger.warn(
            `sop-guard: flow "${flow.sop.skill}" ended at step ${flow.index + 1}/${flow.sop.steps.length}` +
              ` (${flow.sop.steps[flow.index].id}) by ${last ? 'completion' : 'early exit'}; evidence: ${reason};` +
              ` observed tool runs: ${observedSummary(flow)}`,
          )
          state.bySkill.delete(state.active)
          state.active = state.bySkill.keys().next().value ?? null
          // The last flow of this session is gone: drop its file, queued after
          // any save still in flight. Other flows stay on disk, so only save.
          if (state.active === null) forget(String(id))
          else persist(String(id))
        }
        return `已结束流程；${renderStatus(state)}`
      }
      if (args.step === undefined) {
        const pending = notices.get(String(id)) ?? []
        const text = renderStatus(state, pending)
        // The model has seen the notices now; they do not need repeating.
        if (pending.length > 0) notices.delete(String(id))
        return text
      }
      if (state.active === null) {
        throw new Error('当前会话没有生效中的 SOP：已装载的流程都已结束，重新调用 skill 工具加载即可。')
      }
      const flow = state.bySkill.get(state.active)
      const current = flow.sop.steps[flow.index]
      const next = flow.sop.steps[flow.index + 1]
      const target = args.step
      if (target !== current.id && target !== next?.id) {
        const ids = flow.sop.steps.map((step) => step.id).join(', ')
        throw new Error(
          `申报的步骤 "${target}" 不在可申报范围内：只能申报当前步骤「${current.id}」` +
            (next === undefined ? '（已是最后一步）' : `或下一步「${next.id}」`) +
            `。全部步骤：${ids}。`,
        )
      }
      if (target === next?.id) {
        const evidence = requireEvidence(args, '申报下一步')
        requireApproval(flow, '申报下一步')
        requireObservedWork(flow, '申报下一步')
        // Check the action against the step the call is about to land on, and
        // do it before anything is written: a rejected call must leave the
        // flow exactly where it was.
        if (typeof args.action === 'string' && isGateTool(args.action, flow.sop) && !isToolAllowed(next, args.action)) {
          throw new Error(`步骤「${next.id}」不允许 ${args.action}；本步允许：${listAllowed(next, flow.sop)}。`)
        }
        auditAdvance(ctx, flow, 'advanced', evidence)
        flow.index += 1
        flow.doneWork = 0
        flow.evidence = evidence
        flow.observed = []
        // Confirmation belongs to a step, never to the whole flow.
        flow.approved = false
        // The next step is not declared yet: every step needs its own
        // declaration, otherwise advancing silently carries the permission
        // over and the model can skip sop_step for the rest of the flow.
        flow.declared = false
        persist(String(id))
      } else {
        if (typeof args.action === 'string' && isGateTool(args.action, flow.sop) && !isToolAllowed(current, args.action)) {
          throw new Error(`步骤「${current.id}」不允许 ${args.action}；本步允许：${listAllowed(current, flow.sop)}。`)
        }
        flow.declared = true
        persist(String(id))
      }
      return `已申报。\n${renderStatus(state)}`
    },
  })

  ctx.tools.guard((exec) => {
    const id = exec.agent?.id
    if (id === undefined) return undefined
    const state = resolveSession(ctx, exec.agent, sessions)
    const flow = state === undefined || state.active === null ? undefined : state.bySkill.get(state.active)
    if (flow === undefined) return undefined
    if (!isGateTool(exec.name, flow.sop)) return undefined
    const step = flow.sop.steps[flow.index]
    let reason
    if (!flow.declared) reason = '本步还没有申报'
    else if (!isToolAllowed(step, exec.name)) reason = `本步不允许调用 ${exec.name}`
    else reason = findCommandDenial(step, exec) ?? findProgramDenial(step, exec)
    if (reason === undefined) return undefined
    const text = buildDenial(flow, reason)
    if (mode === 'warn') {
      ctx.logger.warn(`sop-guard: ${text}`)
      return undefined
    }
    return text
  })

  // Counting observed work is synchronous: `tools/result` observers are
  // fire-and-forget, so nothing that arms a flow may live here (see below).
  ctx.on('tools/result', (exec, result) => {
    const resultKey = exec.agent?.id === undefined ? undefined : String(exec.agent.id)
    if (result.isError === false && resultKey !== undefined && exec.name !== 'skill' && exec.name !== 'sop_step') {
      const tracked = resolveSession(ctx, exec.agent, sessions)
      const active = tracked === undefined || tracked.active === null ? undefined : tracked.bySkill.get(tracked.active)
      // A shell command that exited non-zero is a report, not a success: the
      // tool reports it without an error, so only the exit code tells. A
      // background or promoted run has no exit code at all: the command is
      // still going, so it is not observed work either.
      const failed = isFailedResult(exec, result)
      const unsettled = isUnsettledResult(exec, result)
      // A background run settles later, and the model collects the verdict
      // with `job_output`. That read carries the job projection, whose detail
      // holds the exit code, so the finished work can still be observed.
      const job = exec.name === 'job_output' ? result.value?.job : undefined
      const verdict = job === undefined ? undefined : jobOutcome(job)
      const settledJob = verdict === 'ok' && typeof job.kind === 'string' ? job.kind : undefined
      const observedName = settledJob ?? exec.name
      if (!failed && !unsettled && active !== undefined && active.declared && isCommittable(active.sop.steps[active.index], observedName)) {
        // Count every tool the step allows, not only the gated ones: a step may
        // declare only ungated tools (for example `read`), and those calls are
        // the observable work that lets the step advance.
        active.doneWork = (active.doneWork ?? 0) + 1
        // Keep the observation beside the model's own claim: the host saw this
        // tool succeed, which is what an audit compares against the evidence.
        if (active.observed === undefined) active.observed = []
        active.observed.push(observedName)
      }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) {
      const key = String(agent.id)
      sessions.delete(key)
      retired.set(key, agent)
    }
  })

  // `agent/created` is a serial event: the framework awaits each listener's
  // returned promise before the agent's loop is published, so the first gated
  // tool cannot be prepared until the restore has finished. A fire-and-forget
  // restore left a window where its guard saw an empty session and let it pass.
  ctx.on('agent/created', async ({ agent }) => {
    // A resumed or compacted session reuses the id; the old instance is gone.
    if (agent?.id === undefined) return
    const key = String(agent.id)
    retired.delete(key)
    // A resumed session starts with an empty map: restore what it had reached.
    if (stateDir !== undefined && !sessions.has(key)) {
      const state = await restoreFlow(ctx, stateDir, key)
      // The agent may have been disposed while the restore was reading: do not
      // revive a dead session. A resume reuses the id with a new instance, so
      // only the exact dead instance blocks the load.
      if (retired.get(key) === agent) return
      if (state !== undefined && !sessions.has(key)) {
        sessions.set(key, state)
        ctx.logger.warn(`sop-guard: restored the armed SOP flow "${state.active}" for session "${key}"`)
      }
    }
    inheritFlow(ctx, agent, sessions)
  })

  // Arm the flow in post-execute, not in `tools/result`: the framework awaits
  // this waterfall before committing a tool result, but fires `tools/result`
  // observers without awaiting them. A flow armed there could still be loading
  // its checklist when the next gated tool's guard ran and let it through.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (exec.name !== 'skill' || result?.isError === true) return downstream
    const value = result.value
    const skillName = typeof value?.name === 'string' ? value.name : exec.arguments?.name
    const base = value?.resourceBase
    const id = exec.agent?.id
    if (typeof skillName !== 'string' || id === undefined || base?.kind !== 'directory') return downstream
    const key = String(id)
    const loaded = await loadSop(base.path, skillName)
    // The agent may have been disposed during the async read: do not revive it.
    // A resumed session reuses the id with a new agent instance, so only the
    // exact dead instance blocks the load.
    const dead = retired.get(key)
    if (dead !== undefined) {
      if (dead === exec.agent) return downstream
      retired.delete(key)
    }
    // A plain skill leaves the armed flow alone; `done` is the explicit exit.
    if (loaded.kind === 'none') return downstream
    if (loaded.kind === 'broken') {
      const text = `SOP Guard：skill「${skillName}」的 SOP 清单无效，已跳过，这个流程没有生效：${loaded.reason}`
      ctx.logger.warn(`sop-guard: SOP.json for skill "${skillName}" is invalid and was skipped: ${loaded.reason}`)
      // Keep the notice until the model asks for its status: a notice that only
      // appears once is lost when the model does not read that turn.
      const pending = notices.get(key) ?? []
      if (!pending.includes(text)) pending.push(text)
      notices.set(key, pending)
      return { ...downstream, additionalContexts: [brokenNotice(text, skillName), ...(downstream.additionalContexts ?? [])] }
    }
    const state = sessions.get(key) ?? { active: null, bySkill: new Map() }
    // A valid checklist supersedes any earlier notice about a broken one.
    notices.delete(key)
    const previous = state.bySkill.get(skillName)
    // Re-reading an unchanged skill keeps the progress the model already made.
    // Progress belongs to a step *id*, not a position: if the checklist changed
    // while it was loaded, a declaration, a read, or a human approval earned on
    // the old step must not satisfy the different step now at that index. The
    // process-restart path (restoreFlow) already compares ids; keep reload in
    // step with it.
    let flow
    if (previous === undefined) {
      flow = { dir: base.path, sop: loaded.sop, index: 0, declared: false, doneWork: 0, evidence: undefined }
    } else {
      const index = Math.min(previous.index, loaded.sop.steps.length - 1)
      const reachedId = previous.sop.steps[previous.index]?.id
      const same = loaded.sop.steps[index]?.id === reachedId
      if (same) {
        flow = { ...previous, dir: base.path, sop: loaded.sop, index }
      } else {
        ctx.logger.warn(`sop-guard: the checklist for "${skillName}" changed while it was loaded; restarted at step 1`)
        flow = { dir: base.path, sop: loaded.sop, index: 0, declared: false, doneWork: 0, observed: [], approved: false, evidence: undefined }
      }
    }
    state.bySkill.set(skillName, flow)
    state.active = skillName
    sessions.set(key, state)
    persist(key)
    return downstream
  })
}

/** Build the model-facing notice for a skill whose checklist failed to load. */
function brokenNotice(text, skillName) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'sop-guard', form: 'notice', summary: `SOP 清单无效：${skillName}` },
  }
}
