package expo.modules.systemvolume

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Reads and writes the device media volume, so a totem can hold the level the
// dashboard asked for even when somebody presses volume on the remote. Changes
// made elsewhere are reported through the onVolumeChange event.
//
// The level is polled rather than observed: Settings.System is not updated
// reliably by every manufacturer (a Samsung handset reported 7 while the real
// level was 1), and the volume broadcast is not part of the public API. A
// cheap read on a short interval behaves the same on every television.
//
// Note: startObserving and stopObserving are reserved by the Expo event
// system, so the watch functions here carry different names.
private const val VOLUME_CHANGE_EVENT = "onVolumeChange"
private const val AUDIO_STREAM = AudioManager.STREAM_MUSIC
private const val POLL_INTERVAL_MS = 1000L
private const val STEP_EPSILON = 0.001

class SystemVolumeModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var poller: Runnable? = null
  private var lastReportedVolume: Double = -1.0

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun readVolume(): Double {
    val max = audioManager.getStreamMaxVolume(AUDIO_STREAM)
    if (max <= 0) return 0.0

    return audioManager.getStreamVolume(AUDIO_STREAM).toDouble() / max.toDouble()
  }

  private fun applyVolume(level: Double): Double {
    val max = audioManager.getStreamMaxVolume(AUDIO_STREAM)
    if (max <= 0) return 0.0

    val clamped = level.coerceIn(0.0, 1.0)
    val steps = Math.round(clamped * max).toInt().coerceIn(0, max)
    audioManager.setStreamVolume(AUDIO_STREAM, steps, 0)
    lastReportedVolume = steps.toDouble() / max.toDouble()

    return lastReportedVolume
  }

  private fun stopPolling() {
    poller?.let { handler.removeCallbacks(it) }
    poller = null
  }

  override fun definition() = ModuleDefinition {
    Name("SystemVolume")

    Events(VOLUME_CHANGE_EVENT)

    // Level is 0..1 so the JS side never has to know the step count, which
    // differs between televisions.
    Function<Double>("getVolume") { -> readVolume() }

    Function("setVolume") { level: Double -> applyVolume(level) }

    Function<Unit>("startWatching") { ->
      if (poller == null) {
        lastReportedVolume = readVolume()
        val runnable = object : Runnable {
          override fun run() {
            val current = readVolume()
            if (Math.abs(current - lastReportedVolume) >= STEP_EPSILON) {
              lastReportedVolume = current
              sendEvent(VOLUME_CHANGE_EVENT, mapOf("volume" to current))
            }

            handler.postDelayed(this, POLL_INTERVAL_MS)
          }
        }

        poller = runnable
        handler.postDelayed(runnable, POLL_INTERVAL_MS)
      }
    }

    Function<Unit>("stopWatching") { -> stopPolling() }

    OnDestroy { stopPolling() }
  }
}
