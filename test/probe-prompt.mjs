// dsh-bridge/probe-prompt.mjs — deliver a message into an existing DSH session.
//
// Usage:
//   node probe-prompt.mjs <sessionId> "<text>" [queue|steer]
import { DshClient } from '../src/client.mjs'

const sessionId = process.argv[2]
const text = process.argv[3]
const mode = process.argv[4] ?? 'queue'
if (!sessionId || !text) {
  console.error('usage: node probe-prompt.mjs <sessionId> "<text>" [queue|steer]')
  process.exit(2)
}

const dsh = new DshClient()
try {
  const receipt = await dsh.prompt({ sessionId, text, mode })
  console.log('DELIVERED', JSON.stringify(receipt))
} catch (error) {
  console.log('DELIVERY FAILED:', String(error.message ?? error))
  process.exitCode = 1
}
