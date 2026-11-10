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
  private var alarmStreamVolumeBeforeRing: Int? = null
  private val handler = Handler(Looper.getMainLooper())
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
    if (intent == null) {
      resumePendingRing()
      return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
    }
    when (intent?.action) {
      ACTION_SERVICE_CANCEL -> {
        val requestedAlarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID)
        if (requestedAlarmId != null && requestedAlarmId == alarmId) {
          stopRinging()
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf(startId)
          return START_NOT_STICKY
        }
        if (ringStartedAt == 0L) stopSelf(startId)
        return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
      }
      ACTION_SERVICE_COMPLETED -> {
        val requestedAlarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID)
        val requestedOccurrenceId = intent.getStringExtra(AlarmContract.EXTRA_OCCURRENCE_ID)
        if (
          requestedAlarmId == null
          || requestedOccurrenceId == null
          || (ringStartedAt > 0L && (alarmId != requestedAlarmId || occurrenceId != requestedOccurrenceId))
          || !AlarmStore.markDismissed(this, requestedAlarmId, requestedOccurrenceId)
        ) {
          Log.w(TAG, "event=unverified_alarm_dismissal_rejected alarmId=$requestedAlarmId occurrenceId=$requestedOccurrenceId")
          return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
        }
        alarmId = requestedAlarmId
        occurrenceId = requestedOccurrenceId
        OccurrenceWriter.resolve(this, requestedOccurrenceId, "completed")
        stopRinging()
        if (startNextQueuedRing()) return START_STICKY
        stopForeground(STOP_FOREGROUND_REMOVE)
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
        try {
          alarmId?.let {
            val delay = intent.getLongExtra(AlarmContract.EXTRA_DELAY_MS, 75_000L)
            AlarmScheduler.rearm(this, it, delay)
          }
        } catch (error: Exception) {
          Log.e(TAG, "event=rearm_failed alarmId=$alarmId", error)
          return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
        }
        stopRinging()
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
        return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
      }
      ACTION_SET_VOLUME_TIER -> {
        currentTier = maxOf(currentTier, intent.getIntExtra(EXTRA_VOLUME_TIER, 0).coerceIn(0, 3))
        if (!alarmAudioDucked) player?.setVolume(volumeForTier(currentTier), volumeForTier(currentTier))
        return if (ringStartedAt > 0L) START_STICKY else START_NOT_STICKY
      }
      ACTION_START -> {
        startRing(intent)
        return START_STICKY
      }
      else -> return START_NOT_STICKY
    }
    return START_NOT_STICKY
  }

  private fun resumePendingRing() {
    val pending = AlarmStore.getPendingRing(this)
    val pendingAlarmId = pending?.get("alarmId") as? String
    val pendingAlarm = pendingAlarmId?.let { AlarmStore.readAlarms(this)[it] }
    if (
      pending == null
      || pending["snoozed"] == true
      || (pending["state"] as? String) !in setOf("ringing", "challenge_pending", "challenge_active")
      || pendingAlarm == null
    ) {
      stopSelf()
      return
    }
    startRing(
      Intent()
        .putExtra(AlarmContract.EXTRA_ALARM, pendingAlarm.toString())
        .putExtra(AlarmContract.EXTRA_ALARM_ID, pendingAlarmId)
        .putExtra(AlarmContract.EXTRA_SCHEDULED_AT, pending["scheduledAt"] as Long)
        .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, pending["occurrenceId"] as String)
        .putExtra(AlarmContract.EXTRA_TIME_ZONE, pending["timeZone"] as String)
    )
  }

  private fun startRing(intent: Intent) {
    val json = intent.getStringExtra(AlarmContract.EXTRA_ALARM)
    val currentAlarm = json?.let(::JSONObject) ?: run {
      stopSelf()
      return
    }
    val incomingAlarmId = currentAlarm.optString("id")
    val incomingScheduledAt = intent.getLongExtra(AlarmContract.EXTRA_SCHEDULED_AT, System.currentTimeMillis())
    val incomingOccurrenceId = intent.getStringExtra(AlarmContract.EXTRA_OCCURRENCE_ID)
      ?: AlarmStore.occurrenceId(incomingAlarmId, incomingScheduledAt)
    val isRearm = intent.getBooleanExtra(AlarmContract.EXTRA_IS_REARM, false)
    val pending = AlarmStore.getPendingRing(this)
    val pendingState = pending?.get("state") as? String
    val pendingIsActive = pending != null
      && pending["snoozed"] != true
      && (
        pendingState == "ringing"
          || pendingState == "challenge_pending"
          || pendingState == "challenge_active"
          || pendingState == "challenge_completed"
      )
    if (pendingIsActive && pending?.get("occurrenceId") != incomingOccurrenceId) {
      if (ringStartedAt == 0L) resumePendingRing()
      AlarmStore.queueRing(
        this,
        currentAlarm,
        incomingOccurrenceId,
        incomingScheduledAt,
        intent.getStringExtra(AlarmContract.EXTRA_TIME_ZONE) ?: java.util.TimeZone.getDefault().id,
        isRearm
      )
      Log.i(TAG, "event=overlapping_occurrence_queued alarmId=$incomingAlarmId occurrenceId=$incomingOccurrenceId")
      return
    }
    if (
      ringStartedAt > 0L
      && alarmId == incomingAlarmId
      && occurrenceId == incomingOccurrenceId
      && player?.isPlaying == true
    ) return
    alarm = currentAlarm
    alarmId = incomingAlarmId
    scheduledAt = incomingScheduledAt
    ringStartedAt = System.currentTimeMillis()
    occurrenceId = incomingOccurrenceId
    if (wakeLock == null || wakeLock?.isHeld != true) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Wayykup:AlarmRing").apply {
        setReferenceCounted(false)
        acquire(30 * 60 * 1000L)
      }
    }
    alarmAudioDucked = false
    val baseTier = if (currentAlarm.optString("sound") in HIGH_INTENSITY_SOUNDS) 2 else 0
    val rearmCount = alarmId?.let { AlarmStore.chain(this, it).second } ?: 0
    currentTier = (baseTier + rearmCount).coerceIn(0, 3)

    startForeground(NOTIFICATION_ID, buildNotification(currentAlarm))
    maximizeAlarmStreamVolume()
    val timeZone = intent.getStringExtra(AlarmContract.EXTRA_TIME_ZONE)
      ?: java.util.TimeZone.getDefault().id
    OccurrenceWriter.markRinging(this, currentAlarm, occurrenceId!!, scheduledAt, ringStartedAt, timeZone)
    AlarmStore.savePendingRing(
      this,
      currentAlarm,
      occurrenceId!!,
      ringStartedAt,
      scheduledAt,
      timeZone,
      isRearm
    )
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
        .putExtra("challenge", currentAlarm.optString("task", "Shake Your Phone"))
        .putExtra("sound", currentAlarm.optString("sound", "police_siren"))
        .putExtra("testAlarm", currentAlarm.optBoolean("testAlarm", false))
        .putExtra("state", AlarmStore.getPendingRing(this)?.get("state") as? String ?: "ringing")
    )
    playSound(currentAlarm.optString("sound", "police_siren"))
    openAlarmInterface()
    handler.postDelayed(escalateRunnable, ESCALATION_INTERVAL_MS)
  }

  private fun startNextQueuedRing(): Boolean {
    while (true) {
      val queued = AlarmStore.takeNextQueuedRing(this) ?: return false
      val queuedAlarm = queued["alarm"] as? String ?: continue
      val queuedOccurrenceId = queued["occurrenceId"] as? String ?: continue
      if (AlarmStore.isOccurrenceDismissed(this, queuedOccurrenceId)) continue
      startRing(
        Intent()
          .putExtra(AlarmContract.EXTRA_ALARM, queuedAlarm)
          .putExtra(AlarmContract.EXTRA_SCHEDULED_AT, queued["scheduledAt"] as Long)
          .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, queuedOccurrenceId)
          .putExtra(AlarmContract.EXTRA_TIME_ZONE, queued["timeZone"] as String)
          .putExtra(AlarmContract.EXTRA_IS_REARM, queued["isRearm"] as Boolean)
      )
      return ringStartedAt > 0L
    }
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
        val resourceId = when (soundName) {
          "police_siren" -> R.raw.wayykup_police_siren
          "air_raid" -> R.raw.wayykup_air_raid
          "fire_alarm" -> R.raw.wayykup_fire_alarm
          "industrial_klaxon" -> R.raw.wayykup_industrial_klaxon
          "accelerating_beeps" -> R.raw.wayykup_accelerating_beeps
          "metal_clang" -> R.raw.wayykup_metal_clang
          "bass_earthquake" -> R.raw.wayykup_bass_earthquake
          "screech" -> R.raw.wayykup_screech
          "emergency_two_tone" -> R.raw.wayykup_emergency_two_tone
          "chaos_final_boss" -> R.raw.wayykup_chaos_final_boss
          else -> R.raw.wayykup_police_siren
        }
        setDataSource(this@RingService, android.net.Uri.parse("android.resource://$packageName/$resourceId"))
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

  private fun openAlarmInterface() {
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
    restoreAlarmStreamVolume()
    (getSystemService(NotificationManager::class.java))?.cancel(NOTIFICATION_ID)
    ringStartedAt = 0L
  }

  override fun onDestroy() {
    stopRinging()
    super.onDestroy()
  }

  private fun maximizeAlarmStreamVolume() {
    val manager = getSystemService(AudioManager::class.java) ?: return
    try {
      if (alarmStreamVolumeBeforeRing == null) {
        alarmStreamVolumeBeforeRing = manager.getStreamVolume(AudioManager.STREAM_ALARM)
      }
      manager.setStreamVolume(
        AudioManager.STREAM_ALARM,
        manager.getStreamMaxVolume(AudioManager.STREAM_ALARM),
        0
      )
    } catch (error: SecurityException) {
      Log.e(TAG, "Could not raise the alarm stream volume.", error)
    }
  }

  private fun restoreAlarmStreamVolume() {
    val originalVolume = alarmStreamVolumeBeforeRing ?: return
    alarmStreamVolumeBeforeRing = null
    val manager = getSystemService(AudioManager::class.java) ?: return
    try {
      val maxVolume = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
      if (manager.getStreamVolume(AudioManager.STREAM_ALARM) == maxVolume) {
        manager.setStreamVolume(AudioManager.STREAM_ALARM, originalVolume.coerceIn(0, maxVolume), 0)
      }
    } catch (error: SecurityException) {
      Log.e(TAG, "Could not restore the alarm stream volume.", error)
    }
  }

  companion object {
    private val HIGH_INTENSITY_SOUNDS = setOf("screech", "emergency_two_tone", "chaos_final_boss")
    private const val TAG = "WayykupAlarm"
    private const val NOTIFICATION_ID = 42100
    private const val ESCALATION_INTERVAL_MS = 60 * 1000L
    private const val AUDIO_FADE_STEP_MS = 40L
    const val ACTION_START = "com.wayykup.alarm.SERVICE_START"
    const val ACTION_SERVICE_CANCEL = "com.wayykup.alarm.SERVICE_CANCEL"
    const val ACTION_SERVICE_COMPLETED = "com.wayykup.alarm.SERVICE_COMPLETED"
    const val ACTION_SET_AUDIO_DUCKED = "com.wayykup.alarm.SERVICE_SET_AUDIO_DUCKED"
    const val ACTION_SET_VOLUME_TIER = "com.wayykup.alarm.SERVICE_SET_VOLUME_TIER"
    const val EXTRA_AUDIO_DUCKED = "audioDucked"
    const val EXTRA_AUDIO_FADE_DURATION_MS = "audioFadeDurationMs"
    const val EXTRA_VOLUME_TIER = "volumeTier"
  }
}
