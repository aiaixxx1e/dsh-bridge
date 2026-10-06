import { randomUUID } from 'node:crypto'

export const GUIDE_VERSION = 1

export function connectionGuide(pair, side, brokerUrl) {
  const endpoint = side === 'codex' ? '/send-task' : '/send-task-to-codex'
  const payload = JSON.stringify({ pairId: pair.id, text: '在这里填写要交给对方的任务' })
  return `[bridge-onboarding v${GUIDE_VERSION}]
这是中间服务自动发送的连接说明，不是任务。无需回复，不要调用工具，不要把本说明转发给对方；阅读后结束本轮。只有用户明确要求协作或收到实际任务时，才使用下列入口。
你是 ${side === 'codex' ? 'Codex' : 'DeepSeek Harness'} 端。
配对 ID：${pair.id}
Codex 会话 ID：${pair.codexThread}
DSH 会话 ID：${pair.dshSessionId}
服务地址：${brokerUrl}
双方角色由用户指定，不固定谁当产品经理。

派活：POST ${brokerUrl}${endpoint}，Content-Type: application/json，正文 ${payload}
可用本地 HTTP 工具；若只有 shell，可用 PowerShell：
$body = '${payload.replaceAll("'", "''")}'
Invoke-RestMethod -Uri '${(brokerUrl + endpoint).replaceAll("'", "''")}' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
不要按标题猜配对；使用上面的精确 pairId。GET ${brokerUrl}/status 可查询配对，GET ${brokerUrl}/tasks 可查询任务及保存的答复。HTTP accepted/delivered 只代表已接收，不代表完成。

实际任务携带 [bridge-task TASK_ID] 标记，回答时用实际任务 ID 原样带上该标记，不要使用示例 TASK_ID。
${side === 'dsh' ? '收到 Codex 派来的任务后，执行并在最终答复里带上原任务标记，服务按完整回合自动回传。不要再用 codex_send 手发同一答复。' : '收到 DSH 派来的任务后，执行并保留原任务标记；把结果通过 POST ' + brokerUrl + '/to-dsh 发送，JSON 为 {"pairId":' + JSON.stringify(pair.id) + ',"text":"结果正文和原任务标记","mode":"queue"}。不要把结果当新任务调用 /send-task。'}
收到结果或确认消息后，只有任务确实需要后续工作时才再派活；不要对连接说明、ack 或测试回执自动回复或继续派活。
无法调用服务时明确说明原因，不要声称已投递。`
}

/** Caller owns the state lock. Persist intent before each external delivery. */
export async function sendConnectionGuides({ state, pairId, save, dsh, queue, brokerUrl, force = false }) {
  const pair = state.pairs[pairId]
  if (!pair) return { ok: false, error: `unknown pair ${pairId}` }
  const key = JSON.stringify([pair.id, pair.codexThread, pair.dshSessionId, GUIDE_VERSION, brokerUrl])
  if (pair.onboarding?.key !== key) pair.onboarding = { key, version: GUIDE_VERSION, sides: {} }
  const record = pair.onboarding
  for (const side of ['codex', 'dsh']) {
    const previous = record.sides[side]
    // A crash after delivery leaves sending/uncertain, never automatically resend.
    if (!force && previous) continue
    const entry = { state: 'sending', requestId: randomUUID(), at: Date.now() }
    record.sides[side] = entry
    await save()
    try {
      const text = connectionGuide(pair, side, brokerUrl)
      const receipt = side === 'codex'
        ? await queue({ thread: pair.codexThread, message: text })
        : await dsh.prompt({ sessionId: pair.dshSessionId, text, mode: 'queue', requestId: entry.requestId })
      if (side === 'dsh' ? receipt?.accepted !== true : !receipt?.messageId) throw new Error('No delivery receipt')
      entry.state = 'delivered'
      entry.receipt = side === 'codex' ? receipt.messageId : entry.requestId
    } catch (error) {
      entry.state = 'uncertain'
      entry.error = String(error?.message ?? error)
    }
    await save()
  }
  return { ok: Object.values(record.sides).every(entry => entry.state === 'delivered'), onboarding: record }
}
