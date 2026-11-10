package expo.modules.wayykupalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.Manifest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.content.pm.PackageManager
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseDetector
import com.google.mlkit.vision.pose.PoseDetectorOptions
import com.google.mlkit.vision.pose.PoseLandmark
import java.io.File
import java.util.Locale
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class SpeechPhraseRecognizer(
  private val context: Context,
  private val onResult: (Map<String, Any>) -> Unit,
  private val onError: (String) -> Unit,
) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var expectedPhrase = ""

  fun start(phrase: String) {
    require(phrase in setOf("I'M AWAKE!", "GOOD MORNING!", "I'M UP!", "WAKE UP!")) {
      "Choose one of the supported wake-up phrases."
    }
    require(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Allow microphone access to use Yell to Stop."
    }
    expectedPhrase = normalize(phrase)
    mainHandler.post {
      stopInternal()
      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        onError("Speech recognition is unavailable on this device.")
        return@post
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
        || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
      ) {
        onError("On-device speech recognition is unavailable. Download an offline speech model in Settings and try again.")
        return@post
      }
      val activeRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
      recognizer = activeRecognizer
      activeRecognizer.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onResults(results: Bundle?) {
          val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
          val scores = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
          val selected = matches.mapIndexed { index, text ->
            text to (scores?.getOrNull(index)?.toDouble() ?: 0.0)
          }.maxByOrNull { (_, score) -> score }
          val text = selected?.first.orEmpty()
          val confidence = selected?.second ?: 0.0
          val recognized = confidence >= 0.35 && normalize(text) == expectedPhrase
          onResult(mapOf("recognized" to recognized, "text" to text, "confidence" to confidence))
          stopInternal()
        }

        override fun onError(error: Int) {
          this@SpeechPhraseRecognizer.onError("Speech recognition failed (code $error). Tap to try again.")
          stopInternal()
        }
      })
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
      }
      activeRecognizer.startListening(intent)
    }
  }

  fun stop() {
    mainHandler.post { stopInternal() }
  }

  private fun stopInternal() {
    recognizer?.apply {
      cancel()
      destroy()
    }
    recognizer = null
  }

  private fun normalize(text: String): String =
    text.lowercase(Locale.US)
      .replace("i'm", "im")
      .replace("i am", "im")
      .replace(Regex("[^a-z0-9]+"), " ")
      .trim()
}

private fun cachedCameraFile(context: Context, uri: Uri): File? {
  val path = uri.path ?: return null
  val file = File(path).canonicalFile
  val cachePrefix = context.cacheDir.canonicalPath + File.separator
  return file.takeIf { it.path.startsWith(cachePrefix) }
}

private fun removeCachedCameraFile(file: File?) {
  if (file != null && file.exists() && !file.delete()) {
    Log.w("WayykupAlarm", "Could not remove temporary camera image ${file.name}.")
  }
}

class WayykupAlarmModule : Module() {
  private var ringReceiver: BroadcastReceiver? = null
  private var speechPhraseRecognizer: SpeechPhraseRecognizer? = null
  private var poseDetector: PoseDetector? = null
  private val imageLabeler by lazy { ImageLabeling.getClient(ImageLabelerOptions.DEFAULT_OPTIONS) }

  override fun definition() = ModuleDefinition {
    Name("WayykupAlarm")
    Events("ringStarted", "challengeCompleted", "healthChanged", "speechResult", "speechError")

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
              "challenge" to (intent.getStringExtra("challenge") ?: "Shake Your Phone"),
              "sound" to (intent.getStringExtra("sound") ?: "police_siren"),
              "testAlarm" to intent.getBooleanExtra("testAlarm", false),
              "state" to (intent.getStringExtra("state") ?: "ringing")
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
      speechPhraseRecognizer?.stop()
      speechPhraseRecognizer = null
      poseDetector?.close()
      poseDetector = null
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
    AsyncFunction("classifyImage") { uri: String, target: String ->
      require(target.isNotBlank()) { "Choose an object target before recognizing a photo." }
      val imageUri = Uri.parse(uri)
      val temporaryFile = cachedCameraFile(context(), imageUri)
      try {
        val image = InputImage.fromFilePath(context(), imageUri)
        Tasks.await(imageLabeler.process(image))
          .sortedByDescending { it.confidence }
          .take(12)
          .map { mapOf("label" to it.text, "confidence" to it.confidence.toDouble()) }
      } finally {
        removeCachedCameraFile(temporaryFile)
      }
    }
    AsyncFunction("detectPushUpPose") { uri: String ->
      val imageUri = Uri.parse(uri)
      val temporaryFile = cachedCameraFile(context(), imageUri)
      try {
        val image = InputImage.fromFilePath(context(), imageUri)
        val options = PoseDetectorOptions.Builder()
          .setDetectorMode(PoseDetectorOptions.SINGLE_IMAGE_MODE)
          .build()
        val detector = poseDetector ?: PoseDetection.getClient(options).also { poseDetector = it }
        val pose = Tasks.await(detector.process(image))
        val names = mapOf(
          "leftShoulder" to PoseLandmark.LEFT_SHOULDER,
          "leftElbow" to PoseLandmark.LEFT_ELBOW,
          "leftWrist" to PoseLandmark.LEFT_WRIST,
          "leftHip" to PoseLandmark.LEFT_HIP,
          "leftAnkle" to PoseLandmark.LEFT_ANKLE,
          "rightShoulder" to PoseLandmark.RIGHT_SHOULDER,
          "rightElbow" to PoseLandmark.RIGHT_ELBOW,
          "rightWrist" to PoseLandmark.RIGHT_WRIST,
          "rightHip" to PoseLandmark.RIGHT_HIP,
          "rightAnkle" to PoseLandmark.RIGHT_ANKLE,
        )
        names.mapNotNull { (name, type) ->
          pose.getPoseLandmark(type)?.let { landmark ->
            name to mapOf(
              "x" to (landmark.position.x / image.width).toDouble(),
              "y" to (landmark.position.y / image.height).toDouble(),
              "confidence" to landmark.inFrameLikelihood.toDouble(),
            )
          }
        }.toMap()
      } finally {
        removeCachedCameraFile(temporaryFile)
      }
    }
    AsyncFunction("cancel") { alarmId: String ->
      AlarmScheduler.cancel(context(), alarmId, removeDefinition = true)
    }
    AsyncFunction("activateChallenge") { alarmId: String, occurrenceId: String ->
      AlarmStore.activateChallenge(context(), alarmId, occurrenceId)
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
    AsyncFunction("cancelChain") { alarmId: String, status: String, occurrenceId: String ->
      require(status == "completed") { "Only a successfully completed challenge can dismiss an alarm." }
      val ring = AlarmStore.getPendingRing(context())
      require(ring?.get("occurrenceId") == occurrenceId) {
        "The active alarm occurrence does not match the completed challenge."
      }
      AlarmScheduler.cancelChain(context(), alarmId, occurrenceId)
      OccurrenceWriter.resolve(context(), occurrenceId, status)
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
      AlarmStore.getPendingRing(context())?.takeIf {
        it["snoozed"] != true
          && (it["state"] as? String) in setOf("ringing", "challenge_pending", "challenge_active")
      }
    }
    AsyncFunction("consumePendingChallenge") {
      AlarmStore.clearPendingRing(context())
    }
    AsyncFunction("startTestAlarm") {
      AlarmScheduler.scheduleTest(context())
    }
    AsyncFunction("startSpeechRecognition") { phrase: String ->
      val speech = speechPhraseRecognizer ?: SpeechPhraseRecognizer(
        context(),
        { result -> sendEvent("speechResult", result) },
        { reason -> sendEvent("speechError", mapOf("reason" to reason)) }
      ).also { speechPhraseRecognizer = it }
      speech.start(phrase)
    }
    AsyncFunction("stopSpeechRecognition") {
      speechPhraseRecognizer?.stop()
    }
    AsyncFunction("setAlarmAudioDucked") { ducked: Boolean, fadeDurationMs: Double ->
      context().startService(
        Intent(context(), RingService::class.java)
          .setAction(RingService.ACTION_SET_AUDIO_DUCKED)
          .putExtra(RingService.EXTRA_AUDIO_DUCKED, ducked)
          .putExtra(RingService.EXTRA_AUDIO_FADE_DURATION_MS, fadeDurationMs.toLong())
      )
    }
    AsyncFunction("setAlarmVolumeTier") { tier: Int ->
      context().startService(
        Intent(context(), RingService::class.java)
          .setAction(RingService.ACTION_SET_VOLUME_TIER)
          .putExtra(RingService.EXTRA_VOLUME_TIER, tier.coerceIn(0, 3))
      )
    }
  }

  private fun context(): Context =
    appContext.reactContext ?: throw IllegalStateException("React application context is unavailable")

  private companion object {
  }
}
