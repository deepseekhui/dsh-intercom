/**
 * 对讲机（intercom）：把一个会话的话，直接送进另一个会话。
 *
 * 跟 bridge.mjs 的信箱不是一回事：
 *   信箱 = 投进文件，等人去看；
 *   对讲机 = 直接往目标会话的 Agent 里塞一条用户消息，那边当场醒过来回话。
 *
 * 用的是宿主自己的协议：createUserMessage(...) + agent.followup(message)。
 * 不伪造 Cookie、不走 HTTP、不碰签名密钥。
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-intercom'
export const inject = ['agents', 'sessions', 'sessionQuery', 'agentDefaultModel', 'webServer']

export function apply(ctx, config) {
  let createUserMessage

  const loadLlm = async () => {
    if (createUserMessage) return createUserMessage
    const mod = await import('@deepseek-ai/dsh-llm/message')
    createUserMessage = mod.createUserMessage
    if (typeof createUserMessage !== 'function') throw new Error('dsh-llm 里没有 createUserMessage')
    return createUserMessage
  }

  /**
   * 叫醒一个冷会话：照 API 控制器那条路走 ——
   * observeSession → 读 agentPreset → compose（agentPresets.mount）→ agents.resume。
   * 只支持预设已经装在这台机器上的情况（手机这边都是 standard）。
   */
  const wake = async (sessionId) => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live

    const observation = await ctx.sessionQuery.observeSession(sessionId)
    if (observation?.header?.cwd === undefined) throw new Error('这个会话没有 cwd，唤不醒')

    const presetId = observation.projections?.values?.agentPreset
    const presets = ctx.get('agentPresets')
    const { provider, model } = ctx.agentDefaultModel.currentSelection()

    const setup = async (agentCtx) => {
      if (presets === undefined) return
      const resolved = (await presets.resolve(presetId)).id
      await presets.mount(agentCtx, resolved)
    }

    const resumed = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider, model },
      setup,
    })
    const agent = resumed?.agent ?? resumed
    if (agent === undefined) throw new Error('唤醒失败：没有拿到 Agent')
    return agent
  }



  /**
   * 往一个会话送一句话（叫醒、塞消息）。广播和单发走同一条路。
   * 不记账 —— 记账留给调用方，因为一次广播要按目标数扣几次。
   */
  const 投递 = async (target, text) => {
    const agent = await wake(target)
    const make = await loadLlm()
    const message = make({
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: `intercom-${randomUUID()}` },
    })
    agent.followup(message)
  }

  /** 当前活着的会话（能当场醒着答话的那种）。 */
  const 活着的会话 = () => {
    const out = []
    for (const session of ctx.sessions.list()) {
      if (ctx.agents.get(session.id) !== undefined) {
        out.push({ id: session.id, title: titleOf(session) })
      }
    }
    return out
  }

  /** ── 限流 ──────────────────────────────────────────────
   * 两个 AI 互相答话会自我循环：一句接一句，没人喊停。
   * 所以按「窗口内最多 N 次」硬拦，默认 60 分钟 10 次。
   */
  // 路径不再写死：默认落在 $DSH_HOME 下，想放别处就在 config 里给目录。
  const 家目录 = config?.dataDir || process.env.DSH_HOME || join(homedir(), '.dsh')
  const 配置文件 = join(家目录, 'intercom-config.json')

  const 读配置 = () => {
    try {
      if (!existsSync(配置文件)) return {}
      return JSON.parse(readFileSync(配置文件, 'utf8')) || {}
    } catch {
      return {}
    }
  }

  const 初始 = 读配置()
  let 限额 = Math.max(1, Number(初始?.maxPerWindow ?? config?.maxPerWindow ?? 10) || 10)
  let 窗口毫秒 = Math.max(1, Number(初始?.windowMinutes ?? config?.windowMinutes ?? 60) || 60) * 60 * 1000
  const 状态文件 = join(家目录, 'intercom-state.json')

  const 读状态 = () => {
    try {
      if (!existsSync(状态文件)) return { sends: [] }
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      return { sends: Array.isArray(j?.sends) ? j.sends : [] }
    } catch {
      return { sends: [] }
    }
  }

  const 写状态 = (st) => {
    try {
      writeFileSync(状态文件, JSON.stringify(st, null, 2))
    } catch {}
  }

  const 活着 = (st) => {
    const since = Date.now() - 窗口毫秒
    return st.sends.filter((t) => typeof t === 'number' && t > since)
  }

  const 剩余 = () => {
    const st = 读状态()
    return Math.max(0, 限额 - 活着(st).length)
  }

  const 概要 = () => {
    const alive = 活着(读状态())
    const oldest = alive.length ? Math.min(...alive) : 0
    return {
      limit: 限额,
      windowMinutes: Math.round(窗口毫秒 / 60000),
      used: alive.length,
      left: Math.max(0, 限额 - alive.length),
      resetsInMinutes: alive.length ? Math.max(0, (oldest + 窗口毫秒 - Date.now()) / 60000) : 0,
    }
  }

  const 记账 = () => {
    const st = 读状态()
    const alive = 活着(st)
    alive.push(Date.now())
    写状态({ sends: alive })
  }


  // ── 设置页的接口（客户端只走同源 HTTP，不碰 RPC） ──
  {
    const 前缀 = '/intercom'
    const 读体 = (req) =>
      new Promise((resolve) => {
        let data = ''
        req.on('data', (c) => {
          data += c
          if (data.length > 8192) req.destroy()
        })
        req.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {})
          } catch {
            resolve({})
          }
        })
        req.on('error', () => resolve({}))
      })
    const 回 = (res, code, obj) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    }

    ctx.webServer.register({
      kind: 'prefix',
      path: 前缀,
      handler: async (req, res) => {
        const route = (req.url ?? '').split('?')[0].slice(前缀.length) || '/'
        try {
          if (route === '/status' && req.method === 'GET') return 回(res, 200, 概要())

          // 群发：设置页那个输入框用这个。默认发给所有活着的会话。
          if (route === '/targets' && req.method === 'GET') {
            return 回(res, 200, { sessions: 活着的会话() })
          }

          if (route === '/broadcast' && req.method === 'POST') {
            const body = await 读体(req)
            const text = String(body?.text || '').trim()
            if (!text) return 回(res, 400, { error: '要说的话呢' })

            const 全部 = 活着的会话()
            const 想发 = Array.isArray(body?.to) && body.to.length
              ? 全部.filter((s) => body.to.some((t) => String(t).startsWith(String(s.id).replace(/^session-/, '')) || s.id === t))
              : 全部
            if (!想发.length) return 回(res, 400, { error: '没有活着的会话可发' })

            if (剩余() < 想发.length) {
              return 回(res, 429, {
                error: `额度不够：这次要扣 ${想发.length} 次（每个目标一次），这个窗口只剩 ${剩余()} 次。`,
                ...概要(),
              })
            }

            const results = []
            let 用掉 = 0
            for (const s of 想发) {
              try {
                await 投递(s.id, '〔群发〕' + text)
                记账()
                用掉++
                results.push({ id: s.id, title: s.title, ok: true })
              } catch (e) {
                results.push({ id: s.id, title: s.title, ok: false, error: String(e?.message || e) })
              }
            }
            return 回(res, 200, { results, charged: 用掉, ...概要() })
          }

          if (route === '/config' && req.method === 'POST') {
            const body = await 读体(req)
            const 新上限 = Number(body?.maxPerWindow)
            const 新窗口 = Number(body?.windowMinutes)
            if (!Number.isFinite(新上限) || 新上限 < 1 || 新上限 > 100) {
              return 回(res, 400, { error: '上限要落在 1–100 之间' })
            }
            if (!Number.isFinite(新窗口) || 新窗口 < 1 || 新窗口 > 1440) {
              return 回(res, 400, { error: '窗口要落在 1–1440 分钟之间' })
            }
            限额 = Math.floor(新上限)
            窗口毫秒 = Math.floor(新窗口) * 60 * 1000
            try {
              writeFileSync(配置文件, JSON.stringify({ maxPerWindow: 限额, windowMinutes: Math.round(窗口毫秒 / 60000) }, null, 2))
            } catch {}
            return 回(res, 200, { ...概要(), saved: true })
          }

          return 回(res, 404, { error: '没有这个接口' })
        } catch (e) {
          return 回(res, 500, { error: String(e?.message || e) })
        }
      },
    })
  }

  /** 磁盘上的会话目录名（不依赖任何服务，稳）。 */
  const persistedIds = () => {
    const out = new Set()
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const root = join(home, 'sessions')
      for (const slug of readdirSync(root)) {
        let dirs = []
        try { dirs = readdirSync(join(root, slug)) } catch { continue }
        for (const d of dirs) {
          const m = /^session-([0-9a-f-]{36})$/.exec(d)
          if (m) out.add(`session-${m[1]}`)
        }
      }
    } catch (e) {
      try { writeFileSync('/tmp/intercom-debug.log', `persistedIds 失败: ${e}\n`, { flag: 'a' }) } catch {}
    }
    return out
  }

  const titleOf = (session) => {
    try {
      const t = ctx.get('sessionTitle')?.of?.(session)
      if (typeof t === 'string' && t.trim()) return t.trim()
    } catch {}
    return ''
  }

  ctx.inject(['tools'], (scope) => {

    scope.effect(() =>
      scope.tools.register({
        name: 'intercom_status',
        description: '看这条线还剩几次额度：窗口多长、上限多少、这个窗口已经发了几次、什么时候能再发。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer' },
              used: { type: 'integer' },
              left: { type: 'integer' },
              windowMinutes: { type: 'integer' },
              resetsInMinutes: { type: 'number' },
            },
          },
          render: (_a, v) =>
            v?.left > 0
              ? [{ type: 'text', text: `这窗口还剩 ${v.left} 次（上限 ${v.limit}，${v.windowMinutes} 分钟一个窗口）。` }]
              : [{ type: 'text', text: `用完了（上限 ${v.limit}）。约 ${Math.ceil(v.resetsInMinutes)} 分钟后能再发。` }],
        },
        async execute() {
          return 概要()
        },
      }),
    )

    scope.effect(() =>
      scope.tools.register({
        name: 'intercom_list',
        description:
          '列出这台机器上活着的会话（就是一个个对话）。发话之前先用它看看对方在哪个会话里。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    agent: { type: 'boolean' },
                  },
                  required: ['id'],
                },
              },
            },
          },
          render: (_a, v) => {
            const rows = (v?.sessions || []).map((s) => `${s.id}${s.title ? ` — ${s.title}` : ''}${s.agent ? ' [活着]' : ''}`)
            return [{ type: 'text', text: rows.length ? rows.join('\n') : '（没有活着的会话）' }]
          },
        },
        async execute() {
          const list = []
          for (const session of ctx.sessions.list()) {
            const agent = ctx.agents.get(session.id)
            list.push({ id: session.id, title: titleOf(session), agent: agent !== undefined })
          }
          return { sessions: list }
        },
      }),
    )

    scope.effect(() =>
      scope.tools.register({
        name: 'intercom_send',
        description:
          '跨会话说一句话：把文本作为一条"用户消息"送进目标会话，那边会被叫醒并回话。' +
          '会话 id 用 intercom_list 查；也接受唯一前缀。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            to: { type: 'string', description: '目标会话 id，或它的一段唯一前缀' },
            text: { type: 'string', description: '要送过去的话。' },
          },
          required: ['to', 'text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              to: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_a, v) =>
            v?.ok
              ? [{ type: 'text', text: `送到了（${v.to}）。那边会被叫醒。` }]
              : [{ type: 'text', text: `没送到：${v?.error || '原因不明'}` }],
        },
        async execute(args) {
          const to = String(args?.to || '').trim()
          const text = String(args?.text || '').trim()
          if (!to) return { ok: false, error: 'to 不能空' }
          if (!text) return { ok: false, error: 'text 不能空' }

          // 限流：窗口内次数用完就停，别让两边互相答话跑飞。
          if (剩余() <= 0) {
            return {
              ok: false,
              error: `这个窗口（${Math.round(窗口毫秒 / 60000)} 分钟）的 ${限额} 次已经用完了，停在这里。等窗口过去再说。`,
            }
          }

          const ids = new Set(ctx.sessions.list().map((s) => s.id))
          for (const id of persistedIds()) ids.add(id)
          const idsArr = [...ids]
          const norm = (v) => String(v).trim().replace(/^session-/, '')
          const want = norm(to)
          const hits = idsArr.filter((id) => norm(id) === want || norm(id).startsWith(want))
          if (hits.length === 0) return { ok: false, error: `没有这个会话：${to}` }
          const target = hits.find((id) => ctx.agents.get(id) !== undefined) || hits[0]
          if (hits.length > 1 && !hits.includes(to)) {
            return { ok: false, error: `前缀不唯一，匹配到 ${hits.length} 个：${hits.slice(0, 3).join(', ')}` }
          }

          let agent
          try {
            agent = await wake(target)
          } catch (e) {
            return { ok: false, error: `叫不醒：${String(e?.message || e)}` }
          }

          try {
            const make = await loadLlm()
            const message = make({
              content: [{ type: 'text', text }],
              source: { kind: 'user', rpcId: `intercom-${randomUUID()}` },
            })
            agent.followup(message)
            记账()
            return { ok: true, to: target }
          } catch (e) {
            return { ok: false, error: String(e?.message || e) }
          }
        },
      }),
    )

    scope.effect(() =>
      scope.tools.register({
        name: 'intercom_broadcast',
        description:
          '对着所有活着的会话同时说一句话（会把自己排除在外，不会喊醒自己）。收到的消息前面带「〔群发〕」，收件人一眼能看出这不是亲口说的。' +
          '每个目标扣一次额度。同一个屋子里的几个人会各自回话，但彼此看不见对方答了什么。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要同时发出去的话。' },
          },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              charged: { type: 'integer' },
              left: { type: 'integer' },
              sent: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { to: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } },
                  required: ['to', 'ok'],
                },
              },
              error: { type: 'string' },
            },
          },
          render: (_a, v) => {
            if (!v?.ok) return [{ type: 'text', text: `没发出去：${v?.error || '原因不明'}` }]
            const rows = (v.sent || []).map((s) => `${s.ok ? '✓' : '✗'} ${s.to}${s.error ? `（${s.error}）` : ''}`)
            return [{ type: 'text', text: `群发 ${rows.length} 个，扣 ${v.charged} 次，剩 ${v.left} 次。\n${rows.join('\n')}` }]
          },
        },
        async execute(args, exec) {
          const text = String(args?.text || '').trim()
          if (!text) return { ok: false, error: 'text 不能空' }

          const 自己 = exec?.agent?.id
          const 目标 = 活着的会话().filter((s) => s.id !== 自己)
          if (!目标.length) return { ok: false, error: '除了自己，没有别的活着的会话' }

          if (剩余() < 目标.length) {
            return {
              ok: false,
              error: `额度不够：这次要扣 ${目标.length} 次（每个目标一次），这个窗口只剩 ${剩余()} 次。`,
            }
          }

          const sent = []
          let charged = 0
          for (const s of 目标) {
            try {
              await 投递(s.id, '〔群发〕' + text)
              记账()
              charged++
              sent.push({ to: s.id, ok: true })
            } catch (e) {
              sent.push({ to: s.id, ok: false, error: String(e?.message || e) })
            }
          }
          return { ok: true, charged, left: 剩余(), sent }
        },
      }),
    )
  })
}
