/**
 * 对讲机 · 客户端半边（手写 bundle，无打包器、无依赖）
 *
 * DSH 的浏览器插件契约只有三条：
 *   1. 必须调用 window.__ModuleLoader__.load({ id, factory })；
 *   2. `id` 必须等于包名（这里是 dsh-intercom）；
 *   3. factory(require) 返回一个 Cordis 插件 { name, inject, apply }。
 *
 * 只注册一个设置页（slot: settings.section），数据结构全走同源 HTTP
 * （/intercom/status、/intercom/config），不碰 RPC。
 */

window.__ModuleLoader__.load({
  id: 'dsh-intercom',

  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/intercom'

    var C = {
      text: 'var(--dsw-alias-text-base)',
      text2: 'var(--dsw-alias-text-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand)',
    }

    function Row(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 0',
            borderBottom: '1px solid ' + C.border,
          },
        },
        h('span', { style: { fontSize: 14, color: C.text } }, props.label),
        h('span', { style: { fontSize: 14, color: C.text2 } }, props.value),
      )
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'block', marginTop: 16 } },
        h('div', { style: { fontSize: 13, color: C.text2, marginBottom: 6 } }, props.label),
        h('input', {
          type: 'number',
          min: props.min,
          max: props.max,
          value: props.value,
          onChange: function (e) {
            var v = parseInt(e.target.value, 10)
            props.onChange(Number.isFinite(v) ? v : 0)
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            fontSize: 14,
            color: C.text,
            background: C.layer,
            border: '1px solid ' + C.border,
            borderRadius: 8,
            outline: 'none',
          },
        }),
      )
    }

    function Section() {
      var s = useState(null)
      var status = s[0]
      var setStatus = s[1]
      var l = useState(10)
      var limit = l[0]
      var setLimit = l[1]
      var w = useState(60)
      var windowMin = w[0]
      var setWindow = w[1]
      var m = useState('')
      var msg = m[0]
      var setMsg = m[1]
      var b = useState(false)
      var busy = b[0]
      var setBusy = b[1]
      // 群发：同时对所有活着的会话说一句
      var tg = useState([])
      var targets = tg[0]
      var setTargets = tg[1]
      var sd = useState('')
      var draft = sd[0]
      var setDraft = sd[1]
      var sb = useState(false)
      var sending = sb[0]
      var setSending = sb[1]
      var sr = useState(null)
      var result = sr[0]
      var setResult = sr[1]

      function loadTargets() {
        fetch(API + '/targets', { credentials: 'same-origin' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            setTargets((j && j.sessions) || [])
          })
          .catch(function () {})
      }

      function broadcast() {
        var text = String(draft || '').trim()
        if (!text || sending) return
        setSending(true)
        setResult(null)
        fetch(API + '/broadcast', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text }),
        })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            setResult(j)
            if (!j || !j.error) setDraft('')
            if (j && typeof j.left === 'number') setStatus(j)
            loadTargets()
          })
          .catch(function (e) {
            setResult({ error: '发不出去：' + String(e) })
          })
          .finally(function () {
            setSending(false)
          })
      }

      function load() {
        fetch(API + '/status', { credentials: 'same-origin' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (j && typeof j.left === 'number') {
              setStatus(j)
              setLimit(j.limit)
              setWindow(j.windowMinutes)
            }
          })
          .catch(function () {})
      }

      useEffect(function () {
        load()
        loadTargets()
      }, [])

      function save() {
        setBusy(true)
        setMsg('')
        fetch(API + '/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxPerWindow: limit, windowMinutes: windowMin }),
        })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (j && j.error) {
              setMsg(j.error)
            } else if (j) {
              setStatus(j)
              setMsg('存好了。')
            }
          })
          .catch(function (e) {
            setMsg('存不进去：' + String(e))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      return h(
        'div',
        { style: { padding: '8px 2px 24px' } },
        h('h2', { style: { fontSize: 17, margin: '6px 0 4px', color: C.text } }, '对讲机'),
        h('div', { style: { fontSize: 12, color: C.text2, marginBottom: 10 } }, '这条线：洄 ↔ 砚'),
        h(
          'p',
          { style: { fontSize: 13, lineHeight: 1.7, color: C.text2, margin: '0 0 8px', whiteSpace: 'pre-line' } },
          '一个会话的话，直接送进另一个会话，那边会醒过来答。它不是聊天窗：有事才喊，喊了有额度上限。\n额度属于这条线，不属于谁：我发一句、他答一句，都从同一份里扣。',
        ),

        // ── 群发：一句话同时丢给所有活着的会话 ──
        h(
          'div',
          {
            style: {
              margin: '8px 0 20px',
              padding: 14,
              border: '1px solid ' + C.border,
              borderRadius: 12,
              background: C.layer,
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 } }, '同时对几个说话'),
          h(
            'div',
            { style: { fontSize: 12, color: C.text2, lineHeight: 1.6, marginBottom: 10 } },
            targets.length
              ? '会同时送进：' +
                  targets
                    .map(function (s) {
                      return s.title || s.id
                    })
                    .join('、') +
                  '。每个目标扣一次额度。'
              : '现在没有活着的会话（开着的那几个才行）。',
          ),
          h('textarea', {
            value: draft,
            onChange: function (e) {
              setDraft(e.target.value)
            },
            placeholder: '一句话，两边同时收到。',
            rows: 3,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: 14,
              lineHeight: 1.6,
              color: C.text,
              background: 'transparent',
              border: '1px solid ' + C.border,
              borderRadius: 10,
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
            },
          }),
          h(
            'button',
            {
              onClick: broadcast,
              disabled: sending || !String(draft || '').trim() || !targets.length,
              style: {
                marginTop: 10,
                width: '100%',
                padding: '11px 16px',
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: '#ffffff',
                background: 'var(--dsw-alias-brand-primary)',
                border: 'none',
                borderRadius: 10,
                cursor: sending || !String(draft || '').trim() || !targets.length ? 'default' : 'pointer',
                opacity: sending || !String(draft || '').trim() || !targets.length ? 0.5 : 1,
              },
            },
            sending ? '发着…' : '同时发出去',
          ),
          result
            ? h(
                'div',
                { style: { marginTop: 10, fontSize: 13, color: C.text2, whiteSpace: 'pre-line' } },
                result.error
                  ? result.error
                  : '发出去了 ' +
                      result.results.filter(function (r) {
                        return r.ok
                      }).length +
                      ' 个，扣 ' +
                      result.charged +
                      ' 次，还剩 ' +
                      result.left +
                      ' 次。' +
                      (result.results.some(function (r) {
                        return !r.ok
                      })
                        ? '\n没送到：' +
                          result.results
                            .filter(function (r) {
                              return !r.ok
                            })
                            .map(function (r) {
                              return (r.title || r.id) + '（' + r.error + '）'
                            })
                            .join('、')
                        : ''),
              )
            : null,
        ),

        status
          ? h(
              'div',
              null,
              h(Row, { label: '这条线已用（两个方向合计）', value: status.used + ' 次' }),
              h(Row, { label: '还剩', value: status.left + ' 次' }),
              h(Row, {
                label: '窗口长度',
                value: status.windowMinutes + ' 分钟',
              }),
              h(Row, {
                label: '额度恢复',
                value:
                  status.left > 0
                    ? '随时可发'
                    : '约 ' + Math.ceil(status.resetsInMinutes) + ' 分钟后回一次',
              }),
            )
          : h('p', { style: { fontSize: 13, color: C.text2 } }, '读不到状态（宿主那边可能没起来）。'),

        h(Field, { label: '一个窗口最多送几次（1–100）', value: limit, min: 1, max: 100, onChange: setLimit }),
        h(Field, { label: '窗口多长（分钟，1–1440）', value: windowMin, min: 1, max: 1440, onChange: setWindow }),

        h(
          'button',
          {
            onClick: save,
            disabled: busy,
            style: {
              marginTop: 20,
              width: '100%',
              padding: '13px 16px',
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: 1,
              color: '#ffffff',
              background: 'var(--dsw-alias-brand-primary)',
              border: 'none',
              borderRadius: 10,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.55 : 1,
            },
          },
          busy ? '存着…' : '保存设置',
        ),

        msg
          ? h('p', { style: { marginTop: 10, fontSize: 13, color: C.text2 } }, msg)
          : null,

        h(
          'p',
          { style: { marginTop: 22, fontSize: 12, lineHeight: 1.7, color: C.text2 } },
          '改完立刻生效，不用重启。额度是硬拦：用完就是拒绝，不会悄悄多送一条。',
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'intercom', order: 47, label: function () { return '对讲机' } },
          Section,
        )
      })
    }

    return { name: 'dsh-intercom', inject: ['slots'], apply: apply }
  },
})
