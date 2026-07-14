import { connectHarness, createCoderHarness, createResearcherHarness } from './packages/harness/dist/index.mjs'

async function main() {
  console.log('Connecting to daemon...')
  const dx = await connectHarness()
  console.log('Connected.')

  // Test 1 — coder harness (hermes engine, cheap model)
  console.log('\n--- Coder harness (hermes/deepseek) ---')
  const coder = await createCoderHarness(dx, {
    engine: 'hermes',
    workspace: process.cwd(),
    label: 'smoke-coder',
  })
  console.log('Coder spawned:', coder.sessionId)
  const coderOut = await coder.ask('Say "CODER OK" and nothing else.', { timeoutMs: 30000 })
  console.log('Coder reply:', coderOut.slice(-200))
  await coder.kill()

  // Test 2 — researcher harness (hermes/glm)
  console.log('\n--- Researcher harness (hermes/glm) ---')
  const researcher = await createResearcherHarness(dx, {
    label: 'smoke-researcher',
  })
  console.log('Researcher spawned:', researcher.sessionId)
  const researchOut = await researcher.ask('Say "RESEARCHER OK" and nothing else.', { timeoutMs: 30000 })
  console.log('Researcher reply:', researchOut.slice(-200))
  await researcher.kill()

  console.log('\nSmoke test PASS')
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
