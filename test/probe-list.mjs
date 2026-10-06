// dsh-bridge/probe-list.mjs — verify auth + envelope against the live DSH host.
import { DshClient } from '../src/client.mjs'

const dsh = new DshClient()
console.log('baseUrl  :', dsh.baseUrl)
console.log('authority:', dsh.authority)
console.log('dshHome  :', dsh.dshHome)

try {
  const list = await dsh.listSessions({})
  console.log('\n=== session/list OK ===')
  console.log(JSON.stringify(list, null, 2).slice(0, 3000))
} catch (error) {
  console.log('\n=== session/list FAILED ===')
  console.log(String(error.message ?? error))
  process.exitCode = 1
}
