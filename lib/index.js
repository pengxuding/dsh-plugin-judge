// dsh-plugin-judge — Host half (community bundle, plain ESM JavaScript).
// 插件价值裁判：装前审核 + 装后审计 + 模型切换复核提醒。
// See README.md for the design.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'plugin-judge'
export const inject = ['timer']

// ─────────────────────────── 纯函数：启发式扫描器 ───────────────────────────
const STRONG_WORDS = /(必须|不得|禁止|严禁|总是|永远|绝不|must\s+not|never|always|strictly|forbidden|do\s+not)/gi
const TEMPLATE_WORDS = /(严格按照|按以下格式|使用以下模板|严格遵循|exact format|follow this template|must follow)/gi

export function countMatches(text, re) {
  return (String(text || '').match(re) || []).length
}

export function scanSource(src, injected) {
  const srcText = String(src || '')
  const injText = String(injected || '')
  const signals = []
  const add = (name, weight, kind, evidence) => signals.push({ name, weight, kind, evidence })
  // 能力信号（负权重 = 增强）
  if (/defineTool|tools\.register|ctx\.tools/.test(srcText)) add('tool-registration', -4, 'capability', '注册模型工具')
  if (/skills|SkillProvider|registerSkill/.test(srcText)) add('skill-provider', -3, 'capability', '提供技能')
  if (/\bmcp\b/i.test(srcText)) add('mcp-integration', -3, 'capability', 'MCP 集成')
  if (/webServer\.register|registerFetchProvider|registerSearchProvider/.test(srcText)) add('web-capability', -3, 'capability', '网络能力')
  if (/commands\.register/.test(srcText)) add('command-registration', -2, 'capability', '注册命令')
  if (/\.provide\(|ctx\.provide/.test(srcText)) add('service-provider', -3, 'capability', '提供服务')
  if (/registerAdapter/.test(srcText)) add('llm-adapter', -3, 'capability', '模型适配器')
  // 约束信号（正权重 = 压制风险）
  if (/systemPrompt|system-prompt/.test(srcText)) add('prompt-injection', 3, 'constraint', '向系统提示词注入内容')
  if (/complete:\s*(true|!0)/.test(srcText)) add('complete-replace', 6, 'constraint', 'complete:true 整块替换系统提示词')
  if (/agent\/pre-step/.test(srcText)) add('pre-step-interceptor', 6, 'constraint', '拦截 agent/pre-step（可改消息）')
  if (/tools\/pre-execute/.test(srcText)) add('tool-pre-execute', 5, 'constraint', '拦截工具执行前')
  if (/tools\/execute|tools\/post-execute/.test(srcText)) add('tool-pipeline-hook', 4, 'constraint', '钩住工具执行管线')
  if (/\brestrict\(|\bguard\(/.test(srcText)) add('tool-restriction', 4, 'constraint', '限制/守卫模型工具')
  if (/persona/i.test(srcText)) add('persona-injection', 3, 'constraint', '注入人设')
  if (/AGENTS\.md|CLAUDE\.md|instructionFile/.test(srcText)) add('rule-file-injection', 3, 'constraint', '注入规则文件')
  if (/llm\/stream/.test(srcText)) add('llm-stream-hook', 3, 'constraint', '拦截模型流')
  const strongCount = countMatches(injText, STRONG_WORDS)
  if (strongCount > 0) add('strong-directives', Math.min(6, strongCount), 'constraint', `强指令词 x${strongCount}`)
  const tplCount = countMatches(injText, TEMPLATE_WORDS)
  if (tplCount > 0) add('template-enforcement', Math.min(4, tplCount * 2), 'constraint', `模板锁定 x${tplCount}`)
  const capSum = signals.filter((s) => s.kind === 'capability').reduce((a, s) => a + s.weight, 0)
  const conSum = signals.filter((s) => s.kind === 'constraint').reduce((a, s) => a + s.weight, 0)
  const raw = capSum + conSum
  const score = Math.max(0, Math.min(100, Math.round(50 + raw * 4)))
  let cls
  if (raw <= -4) cls = 'capability'
  else if (raw >= 4) cls = 'constraint'
  else if (signals.length > 0) cls = 'hybrid'
  else cls = /styles|theme|slots|React|createElement/.test(srcText) ? 'cosmetic' : 'unknown'
  const verdict = cls === 'capability' ? 'enhancing'
    : cls === 'constraint' ? 'constraining'
    : cls === 'cosmetic' ? 'neutral'
    : cls === 'hybrid' ? 'caution'
    : 'unknown'
  return { cls, score, verdict, capSum, conSum, signals, analyzedChars: srcText.length + injText.length }
}

export function sectionConstraintScore(text) {
  return Math.round(countMatches(text, STRONG_WORDS) * 2 + countMatches(text, TEMPLATE_WORDS) * 3)
}

export function parseTarget(input) {
  const t = String(input || '').trim()
  if (!t) return null
  if (t.startsWith('installed:')) return { kind: 'installed', name: t.slice(10) }
  if (t.startsWith('npm:')) { const [pkg, ver] = t.slice(4).split('@'); return { kind: 'npm', pkg, ver } }
  if (t.startsWith('github:')) { const [repo, ref] = t.slice(7).split('@'); return { kind: 'github', repo, ref: ref || 'HEAD' } }
  if (t.startsWith('https://')) return { kind: 'url', url: t }
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return { kind: 'github', repo: t, ref: 'HEAD' }
  return { kind: 'npm', pkg: t }
}

export function cleanSub(s) {
  return String(s || '').replace(/^\.\//, '')
}

export function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

export function renderMarkdown(audit) {
  const s = audit.scan || {}
  const lines = [`### 插件裁判：${audit.target}`, '']
  if (audit.error) { lines.push(`**错误**：${audit.error}`); return lines.join('\n') }
  if (audit.kind === 'installed') {
    lines.push(`**已装插件审计**（共 ${(audit.plugins || []).length} 个 bundle）：`, '')
    audit.plugins.forEach((p) => {
      lines.push(`- **${p.name}**${p.version ? `@${p.version}` : ''} — ${p.scan.cls} / ${p.scan.verdict}（风险 ${p.scan.score}）`)
      if (p.description) lines.push(`  ${p.description}`)
    })
    const cons = (audit.plugins || []).filter((p) => p.scan.cls === 'constraint' || p.scan.cls === 'hybrid')
    if (cons.length) {
      lines.push('', '**建议复核的约束类插件**：')
      cons.forEach((p) => lines.push(`  - ${p.name}：${(p.scan.signals || []).filter((x) => x.kind === 'constraint').map((x) => x.evidence).join('；')}`))
    }
    if (audit.inventory) {
      const inv = audit.inventory
      lines.push('', `**运行时表面**：提示词 section ${(inv.promptSections || []).length} 个 · 工具 ${(inv.tools || []).length} 个 · 技能 ${(inv.skills || []).length} 个`)
      const rank = inv.constraintRank || []
      if (rank.length) {
        lines.push('约束面排名（约束词密度 × 权重）：')
        rank.forEach((r, i) => lines.push(`${i + 1}. \`${r.name}\` — 约束分 **${r.score}**${r.highlight ? ' ⚠️' : ''}`))
      }
    }
    return lines.join('\n')
  }
  lines.push(
    `- 分类：**${s.cls}**`,
    `- 压制风险分：**${s.score}/100**（越高越可能限制模型能力）`,
    `- 结论：**${s.verdict}**`,
    '',
  )
  const caps = (s.signals || []).filter((x) => x.kind === 'capability')
  const cons = (s.signals || []).filter((x) => x.kind === 'constraint')
  if (caps.length) { lines.push('能力信号：'); caps.forEach((x) => lines.push(`  - ${x.evidence}`)); lines.push('') }
  if (cons.length) { lines.push('约束信号：'); cons.forEach((x) => lines.push(`  - ${x.evidence}`)); lines.push('') }
  if (audit.description) lines.push(`描述：${audit.description}`, '')
  if (audit.llm) {
    lines.push(`**LLM 裁判**（由 ${audit.llm.judgedBy} 判断）：结论 **${audit.llm.verdict}**，风险分 ${audit.llm.score}`, '')
    ;(audit.llm.reasons || []).forEach((r) => lines.push(`  - ${r}`))
    if (audit.llm.advice) lines.push(`  💡 ${audit.llm.advice}`)
    lines.push('')
  }
  if (audit.llmError) lines.push(`LLM 裁判告警：${audit.llmError}`, '')
  if (audit.fetched && audit.fetched.length) lines.push(`已分析文件：${audit.fetched.join(', ')}`)
  if (audit.fetchErrors && audit.fetchErrors.length) { lines.push('拉取告警：'); audit.fetchErrors.forEach((e) => lines.push(`  - ${e}`)) }
  return lines.join('\n')
}

// ─────────────────────────── 环境与持久化 ───────────────────────────
export function resolveDshHome(env = process.env) {
  const fromEnv = env && env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function resolveProfileDir(loader, env = process.env) {
  if (loader && typeof loader.baseUrl === 'string' && loader.baseUrl) return loader.baseUrl
  try {
    const root = join(resolveDshHome(env), 'profiles')
    for (const entry of readdirSync(root)) {
      const manifestPath = join(root, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) return join(root, entry)
      } catch { /* 跳过损坏的 manifest */ }
    }
  } catch { /* 无 profiles 目录 */ }
  return null
}

function storePath(env = process.env) {
  return join(resolveDshHome(env), 'plugin-judge', 'audits.json')
}

function loadStore(env = process.env) {
  try {
    const p = storePath(env)
    if (!existsSync(p)) return { history: [], lastModel: null }
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return { history: [], lastModel: null } }
}

function saveStore(store, env = process.env) {
  try {
    const p = storePath(env)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(store, null, 2))
  } catch (e) {
    console.error(`[plugin-judge] 保存审核记录失败: ${String(e && e.message || e)}`)
  }
}

// ─────────────────────────── 插件主体 ───────────────────────────
export function apply(ctx) {
  const tools = ctx.get('tools')
  const commands = ctx.get('commands')
  const systemPrompt = ctx.get('systemPrompt')
  const skills = ctx.get('skills')
  const typert = ctx.get('typert')
  const llm = ctx.get('llm')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const connection = ctx.get('connection')
  const loader = ctx.get('loader')

  const store = loadStore()
  const history = Array.isArray(store.history) ? store.history.slice(-50) : []
  let currentModel = store.lastModel || null
  const modelEvents = []
  let reminders = []

  // ── 已装 bundle 清单（profile manifest → node_modules 源码）──
  function installedBundles() {
    const profileDir = resolveProfileDir(loader)
    if (!profileDir) return { profileDir: null, plugins: [], error: '未找到 profile 目录' }
    try {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const bundleNames = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
      const deps = manifest.dependencies || {}
      const plugins = []
      for (const bname of bundleNames) {
        const pdir = join(profileDir, 'node_modules', bname)
        const entry = { name: bname, version: deps[bname] || null, description: '', scan: null, sourceChars: 0 }
        try {
          const pjPath = join(pdir, 'package.json')
          const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
          entry.version = pj.version || entry.version
          entry.description = pj.description || ''
          entry.dsh = pj.dsh || null
          const mainRel = cleanSub(pj.main || (pj.exports && pj.exports['.'] && pj.exports['.'].default) || 'lib/index.js')
          const clientRel = pj.exports && pj.exports['./client'] ? cleanSub(pj.exports['./client']) : null
          const patchRel = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch ? cleanSub(pj.dsh.bundle.patch) : 'cordis.patch.yml'
          const chunks = []
          for (const rel of [mainRel, clientRel, patchRel]) {
            if (!rel) continue
            try {
              const src = readFileSync(join(pdir, rel), 'utf8')
              if (src.length <= 512 * 1024) chunks.push(src)
            } catch { /* 文件不存在（例如未提交构建产物） */ }
          }
          entry.sourceChars = chunks.reduce((a, c) => a + c.length, 0)
          entry.scan = scanSource(chunks.join('\n'), '')
        } catch (e) {
          entry.scan = scanSource('', '')
          entry.error = String(e && e.message || e)
        }
        plugins.push(entry)
      }
      return { profileDir, plugins }
    } catch (e) {
      return { profileDir, plugins: [], error: String(e && e.message || e) }
    }
  }

  // ── 运行时表面 ──
  async function runtimeSurface() {
    const inv = { promptSections: [], tools: [], skills: [], packages: [], constraintRank: [], assembledAt: Date.now() }
    try {
      if (systemPrompt) {
        const asm = await systemPrompt.assemble({})
        inv.promptSections = (asm.sections || []).map((s) => {
          const t = String(s.text || '')
          return { name: String(s.name || ''), chars: t.length, constraintScore: sectionConstraintScore(t) }
        })
        inv.constraintRank = inv.promptSections
          .map((p) => ({ name: p.name, score: p.constraintScore, highlight: p.constraintScore >= 8 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
      }
    } catch (e) { inv.promptSectionsError = String(e && e.message || e) }
    try {
      if (tools) inv.tools = (tools.schemas() || []).map((t) => ({ name: String(t.name || ''), description: String(t.description || '').slice(0, 120) }))
    } catch (e) { inv.toolsError = String(e && e.message || e) }
    try {
      if (skills) {
        const list = await skills.list({})
        inv.skills = (list || []).map((s) => ({ name: String(s.name || ''), description: String(s.description || '').slice(0, 120) }))
      }
    } catch (e) { inv.skillsError = String(e && e.message || e) }
    try {
      if (typert) inv.packages = (typert.listPackages() || []).map((p) => ({ name: String(p.package || ''), face: String(p.face || ''), key: String(p.key || '') }))
    } catch (e) { inv.packagesError = String(e && e.message || e) }
    return inv
  }

  // ── 装前源码拉取（Node 全局 fetch）──
  async function fetchText(url, signal) {
    const res = await fetch(url, { signal: signal || AbortSignal.timeout(20000), redirect: 'follow' })
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  }

  async function fetchSource(target) {
    const files = {}
    const fetched = []
    const fetchErrors = []
    const tryGet = async (label, url, required) => {
      try {
        files[label] = await fetchText(url)
        fetched.push(url)
        return true
      } catch (e) {
        const msg = `${label} (${url}): ${String(e && e.message || e)}`
        if (required) throw new Error(msg)
        fetchErrors.push(msg)
        return false
      }
    }
    if (target.kind === 'github') {
      const base = `https://raw.githubusercontent.com/${target.repo}/${target.ref}`
      try { await tryGet('package.json', `${base}/package.json`, true) } catch (e) { return { error: String(e.message || e) } }
      let main = 'lib/index.js', client = null, patch = 'cordis.patch.yml', pkgName = null
      try {
        const pj = JSON.parse(files['package.json'])
        main = pj.main || (pj.exports && pj.exports['.'] && pj.exports['.'].default) || main
        client = pj.exports && pj.exports['./client'] ? pj.exports['./client'] : null
        patch = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch ? pj.dsh.bundle.patch : patch
        pkgName = pj.name || null
      } catch (e) { fetchErrors.push(`package.json 解析失败: ${String(e.message || e)}`) }
      const mainOk = await tryGet('main', `${base}/${cleanSub(main)}`, false)
      await tryGet('patch', `${base}/${cleanSub(patch)}`, false)
      if (client) await tryGet('client', `${base}/${cleanSub(client)}`, false)
      // GitHub 仓库常不含构建产物 → 用 jsDelivr 拉 npm 发布版
      if (!mainOk && pkgName) {
        const ok2 = await tryGet('main', `https://cdn.jsdelivr.net/npm/${pkgName}/${cleanSub(main)}`, false)
        if (!ok2) await tryGet('main', `https://unpkg.com/${pkgName}/${cleanSub(main)}`, false)
      }
      if (!files.client && client && pkgName) {
        await tryGet('client', `https://cdn.jsdelivr.net/npm/${pkgName}/${cleanSub(client)}`, false)
      }
    } else if (target.kind === 'npm') {
      const ver = target.ver ? `@${target.ver}` : ''
      try { await tryGet('package.json', `https://unpkg.com/${target.pkg}${ver}/package.json`, true) } catch (e) { return { error: String(e.message || e) } }
      let main = 'lib/index.js', client = null
      try {
        const pj = JSON.parse(files['package.json'])
        main = pj.main || (pj.exports && pj.exports['.'] && pj.exports['.'].default) || main
        client = pj.exports && pj.exports['./client'] ? pj.exports['./client'] : null
      } catch (e) { fetchErrors.push(`package.json 解析失败: ${String(e.message || e)}`) }
      await tryGet('main', `https://unpkg.com/${target.pkg}${ver}/${cleanSub(main)}`, false)
      if (client) await tryGet('client', `https://unpkg.com/${target.pkg}${ver}/${cleanSub(client)}`, false)
    } else {
      return { error: '暂不支持该目标类型' }
    }
    return { files, fetched, fetchErrors }
  }

  // ── LLM 裁判 ──
  async function llmJudge(plugin, scan, sel) {
    if (!llm || !sel) return null
    const sys = '你是 DeepSeek Harness 插件审核裁判。你的任务是判断：这套插件注入的规则/约束，对【当前模型】是在帮忙，还是在压制它完成用户任务的能力。强模型不需要低能力补丁式规则；规则会抢占上下文、压制自主判断。判断必须是"规则 × 当前模型"的二元关系，不是插件单方面好坏。只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记。格式：{"verdict": "enhancing|neutral|caution|constraining|obsolete", "score": 0-100 压制风险分, "reasons": [1-3条理由], "advice": "一句话建议"}'
    const user = [
      `插件：${plugin.name || plugin.target}`,
      `描述：${plugin.description || ''}`,
      `启发式扫描：分类 ${scan.cls}，风险分 ${scan.score}，信号 ${(scan.signals || []).map((x) => x.evidence).join('；')}`,
      `当前模型：${sel.provider}/${sel.model}`,
      '请给出判断 JSON。',
    ].join('\n')
    const msg = {
      id: `judge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text: user }],
      source: { kind: 'user' },
    }
    let text = ''
    let reasoning = ''
    try {
      for await (const chunk of llm.stream({ provider: sel.provider, model: sel.model, messages: [msg], system: sys, maxTokens: 2000, purpose: 'compaction' })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'block-end' && chunk.block && Array.isArray(chunk.block.content)) {
          for (const b of chunk.block.content) if (b && b.type === 'text') text += b.text
        }
        if (chunk.type === 'finish') break
      }
    } catch (e) {
      return { error: `LLM 流失败: ${String(e && e.message || e)}` }
    }
    const source = text || reasoning
    const parsed = extractJson(source)
    if (!parsed) return { error: 'LLM 输出无法解析为 JSON', raw: source.slice(0, 800) }
    return {
      verdict: String(parsed.verdict || ''),
      score: Number(parsed.score) || scan.score,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 3) : [],
      advice: String(parsed.advice || ''),
      judgedBy: `${sel.provider}/${sel.model}`,
    }
  }

  // ── 核心审核 ──
  async function audit(targetInput, opts = {}) {
    const useLlm = Boolean(opts.useLlm)
    const target = typeof targetInput === 'string' ? parseTarget(targetInput) : targetInput
    if (!target) return { error: '无法解析目标，请用 github:owner/repo、npm:pkg 或 owner/repo' }
    if (target.kind === 'installed') {
      const got = installedBundles()
      const inv = await runtimeSurface()
      return {
        target: targetInput,
        kind: 'installed',
        profileDir: got.profileDir,
        plugins: got.plugins,
        inventory: inv,
        error: got.error,
        scan: scanSource('', '', {}),
      }
    }
    const got = await fetchSource(target)
    if (got.error) return { error: got.error }
    let description = '', name = target.pkg || target.repo || target.url
    try {
      const pj = JSON.parse(got.files['package.json'])
      name = pj.name || name
      description = pj.description || ''
    } catch { /* 不致命 */ }
    const allSource = [got.files.main, got.files.patch, got.files.client].filter(Boolean).join('\n')
    const scan = scanSource(allSource, got.files.patch || '')
    const result = {
      target: targetInput,
      name,
      description,
      fetched: got.fetched,
      fetchErrors: got.fetchErrors,
      scan,
      judgedUnder: currentModel ? `${currentModel.provider}/${currentModel.model}` : null,
    }
    if (useLlm) {
      let sel = null
      try { sel = agentDefaultModel ? agentDefaultModel.currentSelection() : null } catch { /* 无默认模型服务 */ }
      const j = await llmJudge({ name, description, target: targetInput }, scan, sel)
      if (j && j.error) { result.llmError = j.error; if (j.raw) result.llmRaw = j.raw }
      else if (j) result.llm = j
    }
    history.push({ at: Date.now(), ...result })
    if (history.length > 50) history.splice(0, history.length - 50)
    saveStore({ history, lastModel: currentModel })
    return result
  }

  // ── 模型切换 → 复核提醒 ──
  function buildReminders(fromKey, toKey) {
    const fresh = []
    const seen = new Set()
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]
      const riskCls = h.scan && (h.scan.cls === 'constraint' || h.scan.cls === 'hybrid')
      const riskVerdict = h.scan && (h.scan.verdict === 'constraining' || h.scan.verdict === 'caution')
      if (!riskCls && !riskVerdict) continue
      const key = h.name || h.target
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({
        id: `rem-${h.at}-${i}`,
        at: Date.now(),
        from: fromKey,
        to: toKey,
        plugin: String(key),
        description: String(h.description || '').slice(0, 100),
        scan: { cls: h.scan.cls, score: h.scan.score, verdict: h.scan.verdict },
      })
      if (fresh.length >= 5) break
    }
    if (fresh.length) reminders = fresh.concat(reminders).slice(0, 8)
  }

  function onModelChanged(fromKey, toKey) {
    modelEvents.push({ at: Date.now(), from: fromKey, to: toKey })
    currentModel = { provider: toKey.split('/')[0], model: toKey.split('/').slice(1).join('/') }
    buildReminders(fromKey, toKey)
    saveStore({ history, lastModel: currentModel })
    console.log(`[plugin-judge] model switch: ${fromKey} -> ${toKey}，复核提醒 ${reminders.length} 条`)
  }

  if (agentDefaultModel) {
    try { currentModel = agentDefaultModel.currentSelection() || currentModel } catch { /* 保留持久化值 */ }
    ctx.interval(() => {
      let sel = null
      try { sel = agentDefaultModel.currentSelection() } catch { return }
      const key = sel ? `${sel.provider}/${sel.model}` : null
      const prevKey = currentModel ? `${currentModel.provider}/${currentModel.model}` : null
      if (key !== prevKey && prevKey !== null && key !== null) onModelChanged(prevKey, key)
      else if (key !== prevKey) currentModel = sel
    }, 10000)
  } else {
    // 回退：观察 agent/request 瀑布事件里的实际请求模型
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      try {
        if (config && config.provider && config.model) {
          const key = `${config.provider}/${config.model}`
          const prevKey = currentModel ? `${currentModel.provider}/${currentModel.model}` : null
          if (key !== prevKey && prevKey !== null) onModelChanged(prevKey, key)
          else if (key !== prevKey) currentModel = { provider: config.provider, model: config.model }
        }
      } catch { /* 观察失败不影响请求 */ }
      return config
    })
  }

  // ── 模型工具：judge_plugin ──
  if (tools) {
    ctx.effect(() => tools.register({
      name: 'judge_plugin',
      description: '判断一个 DeepSeek Harness 插件值不值得用：装前审核（拉取源码静态扫描，可选 LLM 裁判）或查看已装插件（installed: 目标）。输入 github:owner/repo、npm:包名 或 installed:名字。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '审核目标：github:owner/repo[@分支]、npm:包名[@版本]、owner/repo 或 installed:名字' },
          useLlm: { type: 'boolean', description: '是否用 LLM 裁判复核（默认 false，先启发式）' },
        },
        required: ['target'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderMarkdown(value) }],
      },
      execute: async (args) => {
        const r = await audit(args.target, { useLlm: args.useLlm })
        if (r.error) return { target: args.target, error: r.error, scan: { cls: 'unknown', score: 0, verdict: 'unknown', signals: [] } }
        return r
      },
    }))
  }

  // ── 命令：/plugin-audit ──
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'plugin-audit',
      description: '审核插件：装前判断值不值得装 / 查看已装插件',
      handler: async (inv) => {
        const target = inv.rawInput.trim() || 'installed:'
        const r = await audit(target)
        if (r.error) return { kind: 'error', text: r.error }
        return { kind: 'success', text: renderMarkdown(r) }
      },
    }))
  }

  // ── Client RPC 桥（connection 服务）──
  if (connection && connection.rpc && connection.rpc.handle) {
    ctx.effect(() => connection.rpc.handle('/plugin-judge', async (endpoint, payload) => {
      switch (endpoint) {
        case 'audit':
          return { ok: true, value: await audit(payload && payload.target, payload || {}) }
        case 'inventory':
          return { ok: true, value: await audit('installed:') }
        case 'watch-state':
          return { ok: true, value: { currentModel, modelEvents: modelEvents.slice(-20), history: history.slice(-20) } }
        case 'reminder-poll':
          return { ok: true, value: { reminders } }
        case 'reminder-dismiss': {
          const id = payload && payload.id
          reminders = reminders.filter((r) => r.id !== id)
          return { ok: true, value: { ok: true } }
        }
        default:
          return { ok: false, error: { code: 'unknown-endpoint', message: `unknown endpoint: ${endpoint}` } }
      }
    }, { authority: 'loopback' }))
  }
}
