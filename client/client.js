// dsh-plugin-judge — Client half (community bundle).
// Served as the package's `./client` export; the web shell executes it through
// window.__ModuleLoader__ (CommonJS-ish factory). No build step needed.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-judge',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    function h() { return React.createElement.apply(null, arguments) }

    var VERDICT_ZH = { enhancing: '增强', neutral: '中性', caution: '谨慎', constraining: '压制', obsolete: '过期', unknown: '未知' }
    var CLS_ZH = { capability: '能力型', constraint: '约束型', hybrid: '混合型', cosmetic: '妆饰型', unknown: '未知' }
    var COLOR = { enhancing: '#16a34a', neutral: '#6b7280', caution: '#d97706', constraining: '#dc2626', obsolete: '#7c3aed', unknown: '#6b7280' }

    var cardStyle = {
      background: 'rgba(127,127,127,0.08)',
      border: '1px solid rgba(127,127,127,0.18)',
      borderRadius: 10, padding: '10px 12px', marginBottom: 10, fontSize: 13, lineHeight: 1.5,
    }

    // Client → Host 桥：connection RPC 频道 /plugin-judge
    function rpcCall(ctx, endpoint, payload) {
      var conn = ctx.get('connection')
      if (!conn || !conn.rpc || !conn.rpc.call) return Promise.reject(new Error('connection 服务不可用'))
      return conn.rpc.call('/plugin-judge', endpoint, payload || {}).then(function (res) {
        if (res && res.ok) return res.value
        var msg = res && res.error && res.error.message ? res.error.message : 'RPC 失败'
        throw new Error(msg)
      })
    }

    function Label(props) { return h('span', { style: { color: 'rgba(127,127,127,0.9)', marginRight: 6 } }, props.children) }
    function Chip(props) { return h('span', { style: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, background: props.color, color: '#fff', marginRight: 6 } }, props.text) }

    function ResultCard(props) {
      var r = props.result
      if (!r) return null
      if (r.error) return h('div', { style: cardStyle }, '错误：' + r.error)
      var s = r.scan || {}
      return h('div', { style: cardStyle },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, String(r.name || r.target)),
        h('div', { style: { marginBottom: 6 } },
          Chip({ text: CLS_ZH[s.cls] || s.cls, color: '#475569' }),
          Chip({ text: (VERDICT_ZH[s.verdict] || s.verdict) + ' · 风险 ' + s.score, color: COLOR[s.verdict] || '#6b7280' })
        ),
        (s.signals || []).length ? h('div', { style: { marginBottom: 4 } },
          (s.signals || []).map(function (sg) {
            return h('div', { key: sg.name, style: { color: sg.kind === 'capability' ? '#16a34a' : '#b45309' } },
              (sg.kind === 'capability' ? '＋ ' : '－ ') + sg.evidence)
          })) : null,
        r.llm ? h('div', { style: { borderTop: '1px solid rgba(127,127,127,0.2)', paddingTop: 6, marginTop: 4 } },
          h('div', { style: { marginBottom: 4 } }, '🤖 LLM 裁判（' + r.llm.judgedBy + '）：' + h('b', null, VERDICT_ZH[r.llm.verdict] || r.llm.verdict) + ' · ' + r.llm.score),
          (r.llm.reasons || []).map(function (x, i) { return h('div', { key: i, style: { color: 'rgba(127,127,127,0.9)' } }, '· ' + x) }),
          r.llm.advice ? h('div', { style: { marginTop: 4, color: '#0ea5e9' } }, '💡 ' + r.llm.advice) : null) : null,
        r.llmError ? h('div', { style: { color: '#dc2626', marginTop: 4 } }, 'LLM 告警：' + r.llmError) : null
      )
    }

    function JudgePanel(props) {
      var ctx = props.ctx
      var inputState = React.useState('')
      var input = inputState[0]
      var setInput = inputState[1]
      var resultState = React.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var watchState = React.useState(null)
      var watch = watchState[0]
      var setWatch = watchState[1]
      var invState = React.useState(null)
      var inv = invState[0]
      var setInv = invState[1]

      React.useEffect(function () {
        var alive = true
        rpcCall(ctx, 'watch-state').then(function (w) { if (alive) setWatch(w) }).catch(function () {})
        rpcCall(ctx, 'inventory').then(function (i) { if (alive) setInv(i) }).catch(function () {})
        return function () { alive = false }
      }, [ctx])

      function runAudit(target, useLlm) {
        setBusy(true)
        rpcCall(ctx, 'audit', { target: target, useLlm: useLlm })
          .then(function (r) { setResult(r); setBusy(false) })
          .catch(function (e) { setResult({ error: String(e && e.message || e) }); setBusy(false) })
      }

      var model = watch && watch.currentModel ? watch.currentModel.provider + '/' + watch.currentModel.model : '未知'

      return h('div', null,
        h('div', { style: { fontSize: 18, fontWeight: 600, marginBottom: 10 } }, '插件裁判'),
        h('div', { style: cardStyle },
          h('div', null, Label({}, '当前模型'), h('b', null, model)),
          h('div', { style: { color: 'rgba(127,127,127,0.9)' } }, '插件价值 = 插件 × 当前模型。模型切换后请复核规则类插件。')
        ),
        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '装前审核（值不值得装）'),
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            h('input', {
              value: input, placeholder: 'github:owner/repo 或 npm:包名',
              onChange: function (e) { setInput(e.target.value) },
              style: { flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit' },
            }),
            h('button', {
              disabled: busy || !input.trim(), onClick: function () { runAudit(input.trim(), true) },
              style: { padding: '6px 14px', borderRadius: 8, border: 'none', background: '#0ea5e9', color: '#fff', cursor: 'pointer' },
            }, busy ? '审核中…' : '审核')
          ),
          ResultCard({ result: result })
        ),
        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '已装插件审计'),
          inv && inv.kind === 'installed' ? h('div', null,
            (inv.plugins || []).length
              ? (inv.plugins || []).map(function (p) {
                  var sc = p.scan || {}
                  var cons = (sc.signals || []).filter(function (x) { return x.kind === 'constraint' })
                  return h('div', { key: p.name, style: { borderTop: '1px solid rgba(127,127,127,0.12)', padding: '6px 0' } },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                      h('b', null, p.name + (p.version ? '@' + p.version : '')),
                      Chip({ text: (CLS_ZH[sc.cls] || sc.cls) + ' · ' + sc.score, color: COLOR[sc.verdict] || '#475569' })
                    ),
                    cons.length ? h('div', { style: { color: '#b45309', marginTop: 2 } },
                      cons.map(function (x) { return x.evidence }).join('；')) : null,
                    p.error ? h('div', { style: { color: '#dc2626' } }, '读取失败：' + p.error) : null
                  )
                })
              : h('div', { style: { color: 'rgba(127,127,127,0.9)' } }, inv.error || '未找到 profile 清单'),
            inv.inventory ? h('div', { style: { marginTop: 8 } },
              h('div', null, `运行时表面：提示词 section ${(inv.inventory.promptSections || []).length} 个 · 工具 ${(inv.inventory.tools || []).length} 个 · 技能 ${(inv.inventory.skills || []).length} 个`),
              (inv.inventory.constraintRank || []).map(function (r) {
                return h('div', { key: r.name, style: { padding: '2px 0' } },
                  h('code', null, r.name), ' — 约束分 ' + r.score + (r.highlight ? ' ⚠️' : ''))
              })
            ) : null
          ) : '加载中…'
        ),
        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '审核历史'),
          (watch && watch.history && watch.history.length)
            ? watch.history.slice().reverse().map(function (hh) {
                return h('div', { key: String(hh.at), style: { padding: '3px 0' } },
                  String(hh.name || hh.target) + ' — ' + (VERDICT_ZH[hh.scan && hh.scan.verdict] || '?') + '（' + (hh.scan && hh.scan.score) + '）')
              })
            : '暂无'
        )
      )
    }

    function ReminderOverlay(props) {
      var ctx = props.ctx
      var remState = React.useState([])
      var reminders = remState[0]
      var setReminders = remState[1]
      var disState = React.useState({})
      var dismissed = disState[0]
      var setDismissed = disState[1]

      React.useEffect(function () {
        function poll() {
          rpcCall(ctx, 'reminder-poll').then(function (r) {
            if (r && Array.isArray(r.reminders)) setReminders(r.reminders.filter(function (x) { return !dismissed[x.id] }))
          }).catch(function () {})
        }
        poll()
        var dispose = ctx.interval(poll, 5000)
        return function () { if (dispose) dispose() }
      }, [dismissed, ctx])

      if (!reminders.length) return null
      return h('div', {
        style: {
          position: 'fixed', top: 16, right: 16, zIndex: 9999, width: 320,
          background: 'rgba(24,24,27,0.96)', border: '1px solid rgba(234,179,8,0.5)', borderRadius: 12,
          padding: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', pointerEvents: 'auto', fontSize: 13, color: '#e4e4e7',
        },
      },
        h('div', { style: { fontWeight: 700, marginBottom: 6, color: '#fbbf24' } }, '🔄 模型已切换，建议复核插件'),
        reminders.map(function (r) {
          return h('div', { key: r.id, style: { borderTop: '1px solid rgba(255,255,255,0.1)', padding: '6px 0' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('b', null, r.plugin),
              h('button', {
                onClick: function () {
                  setDismissed(function (d) { var n = {}; Object.assign(n, d); n[r.id] = true; return n })
                  rpcCall(ctx, 'reminder-dismiss', { id: r.id }).catch(function () {})
                },
                style: { border: 'none', background: 'transparent', color: '#a1a1aa', cursor: 'pointer' },
              }, '忽略')
            ),
            h('div', { style: { color: '#a1a1aa' } }, (r.from || '?') + ' → ' + (r.to || '?') + ' · ' + (CLS_ZH[r.scan && r.scan.cls] || '') + ' · 风险 ' + (r.scan && r.scan.score)),
            r.description ? h('div', { style: { color: '#71717a', fontSize: 12 } }, r.description) : null
          )
        })
      )
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'plugin-judge', order: 30, label: '插件裁判' },
          function () { return h(JudgePanel, { ctx: ctx }) }
        )
      })
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'plugin-judge-reminder', order: 50 },
          function () { return h(ReminderOverlay, { ctx: ctx }) }
        )
      })
    }

    exports.name = 'plugin-judge-client'
    exports.inject = ['timer']
    exports.apply = apply
    return module.exports
  },
})
