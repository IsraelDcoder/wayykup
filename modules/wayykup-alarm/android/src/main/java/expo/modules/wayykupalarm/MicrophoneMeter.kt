package expo.modules.wayykupalarm

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

internal class MicrophoneMeter(
  private val context: Context,
  private val onLevel: (Double) -> Unit,
  private val onError: () -> Unit
) {
  private val running = AtomicBoolean(false)
  @Volatile private var recorder: AudioRecord? = null
  private var worker: Thread? = null

  @Synchronized
  fun start() {
    if (running.get()) return
    check(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Microphone permission is unavailable."
    }

    val minBufferSize = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    check(minBufferSize > 0) { "The microphone is unavailable on this device." }
    val audioRecord = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      max(minBufferSize, BUFFER_SIZE_BYTES)
    )
    check(audioRecord.state == AudioRecord.STATE_INITIALIZED) {
      audioRecord.release()
      "The microphone could not be initialized."
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val builtInMic = context.getSystemService(android.media.AudioManager::class.java)
          ?.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS)
          ?.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
          ?: throw IllegalStateException("The built-in microphone is unavailable.")
        check(audioRecord.setPreferredDevice(builtInMic)) {
          "The built-in microphone could not be selected."
        }
      }
      audioRecord.startRecording()
      check(audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        "The microphone could not start."
      }
    } catch (error: Exception) {
      audioRecord.release()
      throw error
    }

    recorder = audioRecord
    running.set(true)
    worker = Thread({
      val samples = ShortArray(BUFFER_SIZE_SAMPLES)
      while (running.get()) {
        val count = try {
          audioRecord.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
        } catch (_: SecurityException) {
          if (running.get()) onError()
          running.set(false)
          break
        } catch (_: IllegalStateException) {
          if (running.get()) onError()
          running.set(false)
          break
        }
        if (count < 0) {
          if (running.get()) onError()
          running.set(false)
          break
        }
        if (count == 0) continue
        var sumSquares = 0.0
        for (index in 0 until count) {
          val normalized = samples[index] / 32768.0
          sumSquares += normalized * normalized
        }
        val rms = sqrt(sumSquares / count)
        val dbfs = if (rms <= 0.00001) MIN_DBFS else max(MIN_DBFS, 20.0 * log10(rms))
        onLevel(dbfs)
      }
    }, "WayykupMicrophoneMeter").apply { start() }
  }

  @Synchronized
  fun stop() {
    running.set(false)
    val activeRecorder = recorder
    recorder = null
    try {
      activeRecorder?.stop()
    } catch (_: IllegalStateException) {
      // The audio source may already have stopped after a system interruption.
    } finally {
      activeRecorder?.release()
    }
    worker?.interrupt()
    worker = null
  }

  private companion object {
    const val SAMPLE_RATE = 16_000
    const val BUFFER_SIZE_SAMPLES = 1_024
    const val BUFFER_SIZE_BYTES = BUFFER_SIZE_SAMPLES * 2
    const val MIN_DBFS = -100.0
  }
}
