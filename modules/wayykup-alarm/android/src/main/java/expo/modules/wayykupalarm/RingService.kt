package expo.modules.wayykupalarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject

class RingService : Service() {
  private var player: MediaPlayer? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var alarmId: String? = null
  private var occurrenceId: String? = null
  private var alarm: JSONObject? = null
  private var scheduledAt = 0L
  private var ringStartedAt = 0L
  private var audioFocusRequest: AudioFocusRequest? = null
  private val handler = Handler(Looper.getMainLooper())
  private var completedByChallenge = false
  private var currentTier = 0
  private var alarmAudioDucked = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Wayykup:AlarmRing").apply {
      setReferenceCounted(false)
      acquire(30 * 60 * 1000L)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SERVICE_COMPLETED -> {
        completedByChallenge = true
        alarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID) ?: alarmId
        occurrenceId?.let { OccurrenceWriter.resolve(this, it, "completed") }
        alarmId?.let { AlarmStore.clearPendingRing(this) }
        stopRinging()
        stopSelf(startId)
        return START_NOT_STICKY
      }
      AlarmContract.ACTION_SERVICE_REARM -> {
        alarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID) ?: alarmId
        if (player == null && alarmId != null) {
          startForeground(
            NOTIFICATION_ID,
            NotificationCompat.Builder(this, AlarmContract.CHANNEL_ID)
              .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
              .setContentTitle("WAYYKUP")
              .setContentText("Your alarm will ring again shortly.")
              .setCategory(NotificationCompat.CATEGORY_ALARM)
              .setOngoing(true)
              .build()
          )
        }
        stopRinging()
        alarmId?.let {
          val delay = intent.getLongExtra(AlarmContract.EXTRA_DELAY_MS, 75_000L)
          AlarmScheduler.rearm(this, it, delay)
        }
        completedByChallenge = true
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
        return START_NOT_STICKY
      }
      ACTION_SET_AUDIO_DUCKED -> {
        alarmAudioDucked = intent.getBooleanExtra(EXTRA_AUDIO_DUCKED, false)
        if (alarmAudioDucked) {
          player?.setVolume(0f, 0f)
        } else {
          val targetVolume = volumeForTier(currentTier)
          val durationMs = intent.getLongExtra(EXTRA_AUDIO_FADE_DURATION_MS, 600L).coerceIn(0L, 2_000L)
          val steps = (durationMs / AUDIO_FADE_STEP_MS).coerceAtLeast(1L).toInt()
          val stepDelayMs = (durationMs / steps).coerceAtLeast(1L)
          for (step in 1..steps) {
            handler.postDelayed({
              if (!alarmAudioDucked) {
                val volume = targetVolume * step / steps
                player?.setVolume(volume, volume)
              }
            }, step * stepDelayMs)
          }
        }
        return START_NOT_STICKY
      }
      ACTION_START -> startRing(intent)
      else -> return START_NOT_STICKY
    }
    return START_NOT_STICKY
  }

  private fun startRing(intent: Intent) {
    val json = intent.getStringExtra(AlarmContract.EXTRA_ALARM)
    alarm = json?.let(::JSONObject)
    val currentAlarm = alarm ?: run {
      stopSelf()
      return
    }
    alarmId = currentAlarm.optString("id")
    scheduledAt = intent.getLongExtra(AlarmContract.EXTRA_SCHEDULED_AT, System.currentTimeMillis())
    ringStartedAt = System.currentTimeMillis()
    occurrenceId = intent.getStringExtra(AlarmContract.EXTRA_OCCURRENCE_ID)
      ?: AlarmStore.occurrenceId(alarmId ?: return, scheduledAt)
    completedByChallenge = false
    alarmAudioDucked = false
    currentTier = if (currentAlarm.optString("sound") in HIGH_INTENSITY_SOUNDS) 2 else 0

    startForeground(NOTIFICATION_ID, buildNotification(currentAlarm))
    val timeZone = intent.getStringExtra(AlarmContract.EXTRA_TIME_ZONE)
      ?: java.util.TimeZone.getDefault().id
    OccurrenceWriter.markRinging(this, currentAlarm, occurrenceId!!, scheduledAt, ringStartedAt, timeZone)
    AlarmStore.savePendingRing(this, currentAlarm, occurrenceId!!, ringStartedAt, scheduledAt, timeZone)
    val latency = ringStartedAt - scheduledAt
    Log.i(
      TAG,
      "event=fired event=ringStarted alarmId=$alarmId occurrenceId=$occurrenceId testAlarm=${currentAlarm.optBoolean("testAlarm", false)} latencyMs=$latency device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}"
    )
    sendBroadcast(
      Intent(AlarmContract.ACTION_RING_STARTED)
        .setPackage(packageName)
        .putExtra("alarmId", alarmId)
        .putExtra("occurrenceId", occurrenceId)
        .putExtra("at", ringStartedAt)
        .putExtra("scheduledAt", scheduledAt)
        .putExtra("challenge", currentAlarm.optString("task", "Math"))
        .putExtra("sound", currentAlarm.optString("sound", "Air raid"))
        .putExtra("testAlarm", currentAlarm.optBoolean("testAlarm", false))
    )
    playSound(currentAlarm.optString("sound", "Air raid"))
    openChallenge()
    handler.postDelayed(escalateRunnable, ESCALATION_INTERVAL_MS)
  }

  private fun buildNotification(currentAlarm: JSONObject): Notification {
    val showChallenge = PendingIntent.getActivity(
      this,
      0,
      Intent(this, ChallengeActivity::class.java)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, currentAlarm.optString("id"))
        .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, occurrenceId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val systemStop = PendingIntent.getBroadcast(
      this,
      currentAlarm.optString("id").hashCode(),
      Intent(this, AlarmActionReceiver::class.java)
        .setAction(AlarmContract.ACTION_SYSTEM_STOP)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, currentAlarm.optString("id")),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, AlarmContract.CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("WAYYKUP · TIME TO GET UP")
      .setContentText("${currentAlarm.optString("task", "Wake-up")} challenge. Prove you are awake.")
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(showChallenge, true)
      .setContentIntent(showChallenge)
      .addAction(android.R.drawable.ic_lock_idle_alarm, "Stop and re-arm", systemStop)
      .build()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(AlarmContract.CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      AlarmContract.CHANNEL_ID,
      "Wayykup alarms",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Full-screen native wake-up alarms"
      setSound(null, null)
      enableVibration(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
  }

  private fun playSound(soundName: String) {
    requestAlarmAudioFocus()
    try {
      player?.release()
      player = MediaPlayer().apply {
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        val customSoundUri = alarm?.optString("customSoundUri").orEmpty()
        if (customSoundUri.isNotBlank()) {
          setDataSource(this@RingService, android.net.Uri.parse(customSoundUri))
        } else {
          val resourceName = soundName.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
          val resourceId = when (resourceName) {
            "dread_siren" -> R.raw.dread_siren
            "panic_engine" -> R.raw.panic_engine
            "nightmare" -> R.raw.nightmare
            "final_warning" -> R.raw.final_warning
            "beacon" -> R.raw.beacon
            "buzz_saw" -> R.raw.buzz_saw
            "kitchen_phone" -> R.raw.kitchen_phone
            "pulse" -> R.raw.pulse
            "honk" -> R.raw.honk
            "inferno" -> R.raw.inferno
            "redline" -> R.raw.redline
            "bugle_call" -> R.raw.bugle_call
            "countdown" -> R.raw.countdown
            "jackhammer" -> R.raw.jackhammer
            "warpath" -> R.raw.warpath
            else -> R.raw.alarm_tone
          }
          setDataSource(this@RingService, android.net.Uri.parse("android.resource://$packageName/$resourceId"))
        }
        isLooping = true
        setOnPreparedListener {
          val volume = if (alarmAudioDucked) 0f else volumeForTier(currentTier)
          it.setVolume(volume, volume)
          it.start()
          Log.i(TAG, "event=alarm_audio_started alarmId=$alarmId sound=$soundName tier=$currentTier")
        }
        setOnErrorListener { _, what, extra ->
          Log.e(TAG, "Bundled alarm playback failed what=$what extra=$extra")
          true
        }
        prepareAsync()
      }
    } catch (error: Exception) {
      Log.e(TAG, "Could not prepare native alarm audio", error)
    }
  }

  private fun requestAlarmAudioFocus() {
    val manager = getSystemService(AudioManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        .setOnAudioFocusChangeListener { change ->
          if (change == AudioManager.AUDIOFOCUS_GAIN) player?.start()
        }
        .build()
      audioFocusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
  }

  private val escalateRunnable = object : Runnable {
    override fun run() {
      val elapsed = System.currentTimeMillis() - ringStartedAt
      if (elapsed >= MAX_RING_MS) {
        occurrenceId?.let { OccurrenceWriter.resolve(this@RingService, it, "bypassed") }
        alarmId?.let { AlarmStore.clearChain(this@RingService, it) }
        stopRinging()
        stopSelf()
        return
      }
      currentTier = (currentTier + 1).coerceAtMost(3)
      if (!alarmAudioDucked) player?.setVolume(volumeForTier(currentTier), volumeForTier(currentTier))
      handler.postDelayed(this, ESCALATION_INTERVAL_MS)
    }
  }

  private fun volumeForTier(tier: Int): Float = when (tier) {
    0 -> 0.55f
    1 -> 0.72f
    2 -> 0.88f
    else -> 1f
  }

  private fun openChallenge() {
    val intent = Intent(this, ChallengeActivity::class.java)
      .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
      .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, occurrenceId)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    try {
      startActivity(intent)
    } catch (error: Exception) {
      Log.e(TAG, "Could not open the full-screen challenge activity", error)
    }
  }

  private fun stopRinging() {
    handler.removeCallbacksAndMessages(null)
    player?.run {
      try {
        if (isPlaying) stop()
      } catch (error: IllegalStateException) {
        Log.w(TAG, "Alarm player was already stopped during cleanup", error)
      }
      release()
    }
    player = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    val manager = getSystemService(AudioManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { manager?.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      manager?.abandonAudioFocus(null)
    }
    (getSystemService(NotificationManager::class.java))?.cancel(NOTIFICATION_ID)
  }

  override fun onDestroy() {
    if (!completedByChallenge && ringStartedAt > 0 && System.currentTimeMillis() - ringStartedAt < MAX_RING_MS) {
      alarmId?.let { AlarmScheduler.rearm(this, it) }
    }
    stopRinging()
    super.onDestroy()
  }

  companion object {
    private val HIGH_INTENSITY_SOUNDS = setOf("Dread Siren", "Panic Engine", "Nightmare", "Final Warning")
    private const val TAG = "WayykupAlarm"
    private const val NOTIFICATION_ID = 42100
    private const val ESCALATION_INTERVAL_MS = 60 * 1000L
    private const val AUDIO_FADE_STEP_MS = 40L
    private const val MAX_RING_MS = 30 * 60 * 1000L
    const val ACTION_START = "com.wayykup.alarm.SERVICE_START"
    const val ACTION_SERVICE_COMPLETED = "com.wayykup.alarm.SERVICE_COMPLETED"
    const val ACTION_SET_AUDIO_DUCKED = "com.wayykup.alarm.SERVICE_SET_AUDIO_DUCKED"
    const val EXTRA_AUDIO_DUCKED = "audioDucked"
    const val EXTRA_AUDIO_FADE_DURATION_MS = "audioFadeDurationMs"
  }
}
