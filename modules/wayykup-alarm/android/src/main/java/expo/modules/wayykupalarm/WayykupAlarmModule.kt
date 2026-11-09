package expo.modules.wayykupalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import java.io.File
import java.io.FileOutputStream
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WayykupAlarmModule : Module() {
  private var ringReceiver: BroadcastReceiver? = null
  private var microphoneMeter: MicrophoneMeter? = null
  private val imageLabeler by lazy { ImageLabeling.getClient(ImageLabelerOptions.DEFAULT_OPTIONS) }

  override fun definition() = ModuleDefinition {
    Name("WayykupAlarm")
    Events("ringStarted", "challengeCompleted", "healthChanged", "microphoneLevel", "microphoneError")

    OnCreate {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          if (intent.action == AlarmContract.ACTION_HEALTH_CHANGED) {
            sendEvent("healthChanged", AlarmHealth.get(context))
            return
          }
          val alarmId = intent.getStringExtra("alarmId") ?: return
          val occurrenceId = intent.getStringExtra("occurrenceId") ?: return
          if (intent.action == AlarmContract.ACTION_CHALLENGE_COMPLETED) {
            sendEvent("challengeCompleted", mapOf("alarmId" to alarmId, "occurrenceId" to occurrenceId))
            return
          }
          sendEvent(
            "ringStarted",
            mapOf(
              "alarmId" to alarmId,
              "occurrenceId" to occurrenceId,
              "at" to intent.getLongExtra("at", System.currentTimeMillis()),
              "scheduledAt" to intent.getLongExtra("scheduledAt", 0L),
              "challenge" to (intent.getStringExtra("challenge") ?: "math"),
              "sound" to (intent.getStringExtra("sound") ?: "Air raid"),
              "testAlarm" to intent.getBooleanExtra("testAlarm", false)
            )
          )
        }
      }
      ringReceiver = receiver
      val filter = IntentFilter().apply {
        addAction(AlarmContract.ACTION_RING_STARTED)
        addAction(AlarmContract.ACTION_CHALLENGE_COMPLETED)
        addAction(AlarmContract.ACTION_HEALTH_CHANGED)
      }
      if (Build.VERSION.SDK_INT >= 33) {
        appContext.reactContext?.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        appContext.reactContext?.registerReceiver(receiver, filter)
      }
    }

    OnDestroy {
      microphoneMeter?.stop()
      microphoneMeter = null
      ringReceiver?.let { receiver ->
        try {
          appContext.reactContext?.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
          // The receiver may already have been removed during host teardown.
        }
      }
      ringReceiver = null
    }

    AsyncFunction("schedule") { alarm: Map<String, Any?> ->
      AlarmScheduler.schedule(context(), alarm)
    }
    AsyncFunction("classifyImage") { uri: String ->
      val image = InputImage.fromFilePath(context(), Uri.parse(uri))
      Tasks.await(imageLabeler.process(image))
        .sortedByDescending { it.confidence }
        .take(12)
        .map { mapOf("label" to it.text, "confidence" to it.confidence.toDouble()) }
    }
    AsyncFunction("importSound") { uri: String, name: String ->
      val appContext = context()
      val sourceUri = Uri.parse(uri)
      val resolver = appContext.contentResolver
      val mimeType = resolver.getType(sourceUri)
      if (mimeType != null && !mimeType.startsWith("audio/")) {
        throw IllegalArgumentException("Choose an audio file to use as your alarm sound.")
      }
      val extension = name.substringAfterLast('.', "").lowercase()
      if (extension !in setOf("mp3", "m4a", "aac", "wav", "ogg", "flac", "3gp", "opus")) {
        throw IllegalArgumentException("Choose an MP3, M4A, AAC, WAV, OGG, FLAC, 3GP, or OPUS audio file.")
      }
      val soundDirectory = File(appContext.filesDir, "alarm_sounds").apply { mkdirs() }
      val destination = File(soundDirectory, "${java.util.UUID.randomUUID()}.$extension")
      try {
        val input = resolver.openInputStream(sourceUri)
          ?: throw IllegalArgumentException("Wayykup could not read the selected audio file.")
        input.use { source ->
          FileOutputStream(destination).use { target ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var totalBytes = 0L
            while (true) {
              val bytesRead = source.read(buffer)
              if (bytesRead < 0) break
              totalBytes += bytesRead
              if (totalBytes > MAX_SOUND_BYTES) {
                throw IllegalArgumentException("Choose an audio file smaller than 100 MB.")
              }
              target.write(buffer, 0, bytesRead)
            }
          }
        }
      } catch (error: Exception) {
        destination.delete()
        throw error
      }
      mapOf(
        "uri" to Uri.fromFile(destination).toString(),
        "name" to destination.name,
        "displayName" to name.substringBeforeLast('.', name)
      )
    }
    AsyncFunction("cancel") { alarmId: String ->
      AlarmScheduler.cancel(context(), alarmId, removeDefinition = true)
    }
    AsyncFunction("rearm") { alarmId: String, delaySeconds: Double ->
      val delayMs = (delaySeconds * 1000).toLong().coerceIn(60_000L, 300_000L)
      androidx.core.content.ContextCompat.startForegroundService(
        context(),
        Intent(context(), RingService::class.java)
          .setAction(AlarmContract.ACTION_SERVICE_REARM)
          .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
          .putExtra(AlarmContract.EXTRA_DELAY_MS, delayMs)
      )
    }
    AsyncFunction("cancelChain") { alarmId: String, status: String ->
      val ring = AlarmStore.getPendingRing(context())
      AlarmScheduler.cancelChain(context(), alarmId)
      val occurrenceId = ring?.get("occurrenceId") as? String
      if (occurrenceId != null) OccurrenceWriter.resolve(context(), occurrenceId, status)
      if (ring?.get("testAlarm") == true) {
        if (status == "completed") AlarmStore.markTestAlarmPassed(context())
        AlarmStore.removeAlarm(context(), alarmId)
      }
      context().sendBroadcast(
        Intent(AlarmContract.ACTION_CHALLENGE_COMPLETED)
          .setPackage(context().packageName)
          .putExtra("alarmId", alarmId)
          .putExtra("occurrenceId", occurrenceId)
      )
      AlarmStore.clearPendingRing(context())
    }
    AsyncFunction("getHealth") {
      AlarmHealth.get(context())
    }
    AsyncFunction("requestPermissions") {
      AlarmHealth.get(context())
    }
    AsyncFunction("openSettings") { kind: String ->
      AlarmHealth.openSettings(context(), kind)
    }
    AsyncFunction("getPendingChallenge") {
      AlarmStore.getPendingRing(context())
    }
    AsyncFunction("consumePendingChallenge") {
      AlarmStore.clearPendingRing(context())
    }
    AsyncFunction("startTestAlarm") {
      AlarmScheduler.scheduleTest(context())
    }
    AsyncFunction("startMicrophoneMeter") {
      val meter = microphoneMeter ?: MicrophoneMeter(
        context(),
        { dbfs -> sendEvent("microphoneLevel", mapOf("dbfs" to dbfs)) },
        { sendEvent("microphoneError", mapOf("reason" to "resource_unavailable")) }
      ).also { microphoneMeter = it }
      meter.start()
    }
    AsyncFunction("stopMicrophoneMeter") {
      microphoneMeter?.stop()
      microphoneMeter = null
    }
    AsyncFunction("setAlarmAudioDucked") { ducked: Boolean, fadeDurationMs: Double ->
      context().startService(
        Intent(context(), RingService::class.java)
          .setAction(RingService.ACTION_SET_AUDIO_DUCKED)
          .putExtra(RingService.EXTRA_AUDIO_DUCKED, ducked)
          .putExtra(RingService.EXTRA_AUDIO_FADE_DURATION_MS, fadeDurationMs.toLong())
      )
    }
  }

  private fun context(): Context =
    appContext.reactContext ?: throw IllegalStateException("React application context is unavailable")

  private companion object {
    const val MAX_SOUND_BYTES = 100L * 1024 * 1024
  }
}
