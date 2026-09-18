import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

async function loadModule() {
  const moduleUrl = process.env.MEDIA_RECOVERY_POLICY_SOURCE
    ? new URL(`file://${process.env.MEDIA_RECOVERY_POLICY_SOURCE}`)
    : new URL('../components/utils/mediaRecoveryPolicy.js', import.meta.url)
  const source = readFileSync(moduleUrl, 'utf8')
  const context = vm.createContext({ Math, Number, Object })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => {
    throw new Error('The recovery policy must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

// Values crossing the vm realm boundary carry a foreign prototype, so structural
// comparisons go through a plain round trip like the other behaviour suites.
const plain = (value) => JSON.parse(JSON.stringify(value))

const {
  MEDIA_ERROR_DISPLAY_MS,
  MEDIA_RETRY_MAX_DELAY_MS,
  MediaRecoveryAction,
  resolveMediaRecovery,
} = await loadModule()

{
  // A multi-item playlist keeps the pre-existing behaviour: skip the broken item
  // after the error screen has been readable for a moment.
  for (const failureCount of [1, 2, 9]) {
    assert.deepEqual(
      plain(resolveMediaRecovery({ playlistLength: 4, failureCount })),
      { action: MediaRecoveryAction.ADVANCE, delayMs: MEDIA_ERROR_DISPLAY_MS },
      'Advancing must never be delayed by an unrelated failure streak.'
    )
  }
}

{
  const single = (failureCount) =>
    resolveMediaRecovery({ playlistLength: 1, failureCount })

  assert.equal(
    single(1).action,
    MediaRecoveryAction.RETRY,
    'A single-item playlist must recover by retrying itself, not by stalling.'
  )
  assert.equal(
    single(1).delayMs,
    MEDIA_ERROR_DISPLAY_MS,
    'The first retry must follow the error display delay.'
  )

  const delays = [1, 2, 3, 4, 5, 6].map((failureCount) => single(failureCount).delayMs)
  assert.deepEqual(
    delays,
    [2000, 4000, 8000, 16000, 30000, 30000],
    'Repeated failures must back off and then hold at the ceiling.'
  )
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(
      delays[index] >= delays[index - 1],
      'Backoff must never shrink while failures keep accumulating.'
    )
  }
}

{
  // A broken URL failing all night must not overflow into a nonsense delay.
  for (const failureCount of [40, 1000, Number.MAX_SAFE_INTEGER]) {
    const recovery = resolveMediaRecovery({ playlistLength: 1, failureCount })
    assert.equal(recovery.action, MediaRecoveryAction.RETRY)
    assert.equal(
      recovery.delayMs,
      MEDIA_RETRY_MAX_DELAY_MS,
      'A runaway failure counter must saturate at the ceiling.'
    )
  }
}

{
  // The counter is owned by the caller, so hostile values must still yield a
  // schedulable delay rather than NaN or Infinity.
  for (const failureCount of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const recovery = resolveMediaRecovery({ playlistLength: 1, failureCount })
    assert.equal(recovery.action, MediaRecoveryAction.RETRY)
    assert.ok(
      Number.isFinite(recovery.delayMs) &&
        recovery.delayMs >= MEDIA_ERROR_DISPLAY_MS &&
        recovery.delayMs <= MEDIA_RETRY_MAX_DELAY_MS,
      `An unusable failure count must still schedule a bounded retry: ${failureCount}`
    )
  }
}

{
  // With nothing to play the pairing screen is showing; a timer there would only
  // churn state with no item to recover.
  for (const playlistLength of [0, -1, undefined, Number.NaN]) {
    assert.deepEqual(
      plain(resolveMediaRecovery({ playlistLength, failureCount: 1 })),
      { action: MediaRecoveryAction.NONE, delayMs: 0 }
    )
  }
  assert.equal(resolveMediaRecovery().action, MediaRecoveryAction.NONE)
}

{
  const recovery = resolveMediaRecovery({
    playlistLength: 1,
    failureCount: 3,
    baseDelayMs: 100,
    maxDelayMs: 250,
  })
  assert.deepEqual(
    plain(recovery),
    { action: MediaRecoveryAction.RETRY, delayMs: 250 },
    'Callers must be able to override the schedule for faster environments.'
  )
}

const mediaPlayerSource = readFileSync(
  new URL('../components/MediaPlayer.js', import.meta.url),
  'utf8'
)

{
  // The retry path is only safe because the scheduled callback still checks the
  // generation token before acting, exactly as the advance path did.
  const handlerStart = mediaPlayerSource.indexOf('const handleMediaFailure')
  const handlerEnd = mediaPlayerSource.indexOf(
    'watchdogFailureHandlerRef.current',
    handlerStart
  )
  assert.ok(handlerStart !== -1 && handlerEnd > handlerStart)
  const handlerSource = mediaPlayerSource.slice(handlerStart, handlerEnd)

  const guardIndex = handlerSource.indexOf(
    'activeGenerationRef.current !== generation'
  )
  const retryIndex = handlerSource.indexOf('retryCurrentItem()')
  const advanceIndex = handlerSource.indexOf('playNextItem()')
  assert.ok(
    guardIndex !== -1 && guardIndex < retryIndex && guardIndex < advanceIndex,
    'Both recovery actions must sit behind the generation guard.'
  )
  assert.ok(
    handlerSource.includes('claimPlaybackTransition'),
    'Recovery must still be claimed once per generation.'
  )
}

console.log('Media recovery policy behavior checks passed.')
