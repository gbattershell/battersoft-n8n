// scripts/modules/status/index.js
import { report, heartbeat, error as statusError } from '../../core/status.js'
import { send } from '../../core/telegram.js'

export async function run(input) {
  try {
    const text = await report()
    await send(text)
    await heartbeat('status')
  } catch (err) {
    await statusError('status', err)
    throw err
  }
}
