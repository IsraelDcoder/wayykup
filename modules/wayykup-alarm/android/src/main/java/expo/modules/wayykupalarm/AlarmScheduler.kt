package expo.modules.wayykupalarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.text.SimpleDateFormat
import java.util.TimeZone

internal object AlarmScheduler {
  private const val TAG = "WayykupAlarm"
  private const val REARM_LIMIT_MS = 30 * 60 * 1000L
  private const val REARM_DELAY_MS = 75 * 1000L

  fun schedule(context: Context, alarmValues: Map<String, Any?>) {
    val alarm = JSONObject(alarmValues)
    val alarmId = alarm.getString("id")
    require(alarm.optString("task") in setOf("Yell to Stop", "Push-up Challenge", "Shake Your Phone", "Object Hunt")) {
      "Choose one of the four supported wake-up challenges before scheduling this alarm."
    }
    if (!alarm.optBoolean("enabled", true)) {
      cancel(context, alarmId, removeDefinition = true)
      return
    }
    if (AlarmHealth.get(context)["canSchedule"] != true) {
      throw SecurityException("Allow Wayykup to schedule exact alarms before scheduling this alarm.")
    }
    prepareOneShotDate(context, alarm, System.currentTimeMillis())
    AlarmStore.saveAlarm(context, alarm)
    cancelBase(context, alarmId)
    if (AlarmStore.isOneShotConsumed(context, alarm)) {
      Log.i(TAG, "event=one_shot_already_fired alarmId=$alarmId")
      return
    }
    if (scheduleNext(context, alarm, System.currentTimeMillis()) == null && !alarm.optBoolean("testAlarm", false)) {
      AlarmStore.markOneShotFired(context, alarm)
      Log.i(TAG, "event=one_shot_expired alarmId=$alarmId")
      return
    }
    Log.i(TAG, "event=scheduled alarmId=$alarmId device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}")
  }

  fun cancel(context: Context, alarmId: String, removeDefinition: Boolean) {
    cancelBase(context, alarmId)
    cancelRearm(context, alarmId)
    AlarmStore.removeQueuedAlarm(context, alarmId)
    if (AlarmStore.getPendingRing(context)?.get("alarmId") == alarmId) {
      AlarmStore.clearPendingRing(context)
    }
    context.startService(
      Intent(context, RingService::class.java)
        .setAction(RingService.ACTION_SERVICE_CANCEL)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
    )
    AlarmStore.clearChain(context, alarmId)
    if (removeDefinition) AlarmStore.removeAlarm(context, alarmId)
  }

  fun cancelChain(context: Context, alarmId: String, occurrenceId: String) {
    AlarmStore.markChallengeCompleted(context, alarmId, occurrenceId)
    cancelRearm(context, alarmId)
    AlarmStore.clearChain(context, alarmId)
    context.startService(
      Intent(context, RingService::class.java)
        .setAction(AlarmContract.ACTION_SERVICE_COMPLETED)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
        .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, occurrenceId)
    )
  }

  fun rearm(context: Context, alarmId: String, delayMs: Long = REARM_DELAY_MS) {
    val (startedAt, count) = AlarmStore.chain(context, alarmId)
    val chainStart = if (startedAt == 0L) System.currentTimeMillis() else startedAt
    if (System.currentTimeMillis() - chainStart >= REARM_LIMIT_MS || count >= 24) {
      val occurrenceId = AlarmStore.getPendingRing(context)?.get("occurrenceId") as? String
      if (occurrenceId != null) OccurrenceWriter.resolve(context, occurrenceId, "bypassed")
      if (AlarmStore.getPendingRing(context)?.get("alarmId") == alarmId) AlarmStore.clearPendingRing(context)
      AlarmStore.clearChain(context, alarmId)
      cancelRearm(context, alarmId)
      return
    }
    val nextCount = count + 1
    val at = System.currentTimeMillis() + delayMs.coerceIn(60_000L, 300_000L)
    scheduleRearmAt(context, alarmId, at)
    AlarmStore.updateChain(context, alarmId, chainStart, nextCount)
    AlarmStore.markPendingRingSnoozed(context, alarmId, at)
    AlarmStore.getPendingRing(context)?.let { ring ->
      try {
        OccurrenceWriter.updateRearms(context, ring["occurrenceId"] as String, nextCount)
      } catch (error: Exception) {
        Log.e(TAG, "event=rearm_history_update_failed alarmId=$alarmId", error)
      }
    }
    Log.i(TAG, "event=rearm alarmId=$alarmId count=$nextCount fireAt=$at")
  }

  fun scheduleTest(context: Context) {
    val health = AlarmHealth.get(context)
    if (health["canSchedule"] != true) {
      throw SecurityException("Allow Wayykup to schedule exact alarms before running the ring test.")
    }
    AlarmStore.resetTestAlarm(context)
    AlarmStore.readAlarms(context)
      .keys
      .filter { it.startsWith(TEST_ALARM_ID) }
      .forEach { AlarmStore.removeAlarm(context, it) }
    val at = System.currentTimeMillis() + 60_000L
    val calendar = Calendar.getInstance().apply { timeInMillis = at }
    val alarm = JSONObject()
      .put("id", "$TEST_ALARM_ID:$at")
      .put("time", String.format(Locale.US, "%02d:%02d", calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE)))
      .put("days", JSONArray())
      .put("enabled", true)
      .put("task", "Shake Your Phone")
      .put("sound", "police_siren")
      .put("testAlarm", true)
    AlarmStore.saveAlarm(context, alarm)
    scheduleAt(context, alarm, at)
    Log.i(
      TAG,
      "event=test_alarm_scheduled alarmId=${alarm.optString("id")} fireAt=$at delayMs=${at - System.currentTimeMillis()} device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}"
    )
  }

  fun scheduleNext(context: Context, alarm: JSONObject, after: Long): Long? {
    val next = nextTime(alarm, after) ?: return null
    scheduleAt(context, alarm, next)
    return next
  }

  fun rescheduleAll(context: Context) {
    val now = System.currentTimeMillis()
    try {
      restorePendingRearm(context, now)
    } catch (error: Exception) {
      Log.e(TAG, "event=pending_rearm_restore_failed", error)
      context.sendBroadcast(Intent(AlarmContract.ACTION_HEALTH_CHANGED).setPackage(context.packageName))
    }
    AlarmStore.readAlarms(context).values.forEach { alarm ->
      val alarmId = alarm.optString("id")
      try {
        cancelBase(context, alarmId)
        if (alarm.optBoolean("testAlarm", false)) {
          AlarmStore.removeAlarm(context, alarmId)
        } else if (alarm.optBoolean("enabled", true) && !AlarmStore.isOneShotConsumed(context, alarm)) {
          if (scheduleNext(context, alarm, now) == null && (alarm.optJSONArray("days")?.length() ?: 0) == 0) {
            AlarmStore.markOneShotFired(context, alarm)
          }
        }
      } catch (error: Exception) {
        Log.e(TAG, "event=alarm_reschedule_failed alarmId=$alarmId", error)
        context.sendBroadcast(Intent(AlarmContract.ACTION_HEALTH_CHANGED).setPackage(context.packageName))
      }
    }
    Log.i(TAG, "event=rescheduled count=${AlarmStore.readAlarms(context).size}")
  }

  private fun restorePendingRearm(context: Context, now: Long) {
    val pending = AlarmStore.getPendingRing(context) ?: return
    val alarmId = pending["alarmId"] as? String ?: return
    val alarm = AlarmStore.readAlarms(context)[alarmId]
    if (pending["testAlarm"] == true || alarm == null || !alarm.optBoolean("enabled", true)) {
      AlarmStore.clearPendingRing(context)
      AlarmStore.clearChain(context, alarmId)
      cancelRearm(context, alarmId)
      return
    }

    val (startedAt, count) = AlarmStore.chain(context, alarmId)
    val chainStart = if (startedAt == 0L) (pending["at"] as? Long ?: now) else startedAt
    if (now - chainStart >= REARM_LIMIT_MS || count >= 24) {
      (pending["occurrenceId"] as? String)?.let { OccurrenceWriter.resolve(context, it, "bypassed") }
      AlarmStore.clearPendingRing(context)
      AlarmStore.clearChain(context, alarmId)
      cancelRearm(context, alarmId)
      return
    }

    if (startedAt == 0L) AlarmStore.updateChain(context, alarmId, chainStart, count)
    val storedRearmAt = pending["rearmAt"] as? Long ?: 0L
    val rearmAt = if (pending["snoozed"] == true && storedRearmAt > 0L) {
      maxOf(now + 1_000L, storedRearmAt)
    } else {
      now + REARM_DELAY_MS
    }
    scheduleRearmAt(context, alarmId, rearmAt)
    AlarmStore.markPendingRingSnoozed(context, alarmId, rearmAt)
    Log.i(TAG, "event=pending_rearm_restored alarmId=$alarmId fireAt=$rearmAt")
  }

  private fun scheduleRearmAt(context: Context, alarmId: String, at: Long) {
    exactAlarmManager(context).setAlarmClock(
      AlarmManager.AlarmClockInfo(at, launchPendingIntent(context)),
      rearmPendingIntent(context, alarmId)
    )
  }

  private fun scheduleAt(context: Context, alarm: JSONObject, at: Long) {
    val manager = exactAlarmManager(context)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
      throw SecurityException("Allow exact alarms for Wayykup in system settings before scheduling this alarm.")
    }
    val timeZone = TimeZone.getDefault()
    val dateFormatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { this.timeZone = timeZone }
    val occurrenceId = "${alarm.optString("id")}:${dateFormatter.format(Date(at))}"
    val intent = Intent(context, AlarmReceiver::class.java)
      .setAction(AlarmContract.ACTION_ALARM_FIRED)
      .putExtra(AlarmContract.EXTRA_ALARM, alarm.toString())
      .putExtra(AlarmContract.EXTRA_SCHEDULED_AT, at)
      .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, occurrenceId)
      .putExtra(AlarmContract.EXTRA_TIME_ZONE, timeZone.id)
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      requestCode(alarm.optString("id"), "base"),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    manager.setAlarmClock(AlarmManager.AlarmClockInfo(at, launchPendingIntent(context)), pendingIntent)
  }

  private fun nextTime(alarm: JSONObject, after: Long): Long? {
    val parts = alarm.optString("time").split(":")
    if (parts.size != 2) throw IllegalArgumentException("Alarm time must use HH:mm.")
    val hour = parts[0].toIntOrNull() ?: throw IllegalArgumentException("Alarm hour is invalid.")
    val minute = parts[1].toIntOrNull() ?: throw IllegalArgumentException("Alarm minute is invalid.")
    require(hour in 0..23 && minute in 0..59) { "Alarm time is invalid." }
    val days = alarm.optJSONArray("days") ?: JSONArray()
    if (days.length() == 0 && !alarm.optBoolean("testAlarm", false)) {
      val oneShotDate = alarm.optString("oneShotDate")
      if (oneShotDate.isNotBlank()) {
        val dateParts = oneShotDate.split("-")
        if (dateParts.size != 3) throw IllegalArgumentException("Saved one-time alarm date is invalid.")
        val year = dateParts[0].toIntOrNull() ?: throw IllegalArgumentException("Saved one-time alarm year is invalid.")
        val month = dateParts[1].toIntOrNull() ?: throw IllegalArgumentException("Saved one-time alarm month is invalid.")
        val day = dateParts[2].toIntOrNull() ?: throw IllegalArgumentException("Saved one-time alarm day is invalid.")
        val candidate = Calendar.getInstance().apply {
          set(Calendar.YEAR, year)
          set(Calendar.MONTH, month - 1)
          set(Calendar.DAY_OF_MONTH, day)
          set(Calendar.HOUR_OF_DAY, hour)
          set(Calendar.MINUTE, minute)
          set(Calendar.SECOND, 0)
          set(Calendar.MILLISECOND, 0)
        }
        return candidate.timeInMillis.takeIf { it > after }
      }
    }
    val calendar = Calendar.getInstance().apply { timeInMillis = after }
    for (offset in 0..7) {
      val candidate = (calendar.clone() as Calendar).apply {
        add(Calendar.DAY_OF_YEAR, offset)
        set(Calendar.HOUR_OF_DAY, hour)
        set(Calendar.MINUTE, minute)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }
      if (candidate.timeInMillis <= after) continue
      if (days.length() == 0) {
        if (offset == 0) return candidate.timeInMillis
        if (offset == 1) return candidate.timeInMillis
        return null
      }
      val mondayIndex = (candidate.get(Calendar.DAY_OF_WEEK) + 5) % 7
      var matches = false
      for (index in 0 until days.length()) {
        if (days.optString(index) == mondayIndex.toString()) matches = true
      }
      if (matches) return candidate.timeInMillis
    }
    return null
  }

  private fun prepareOneShotDate(context: Context, alarm: JSONObject, after: Long) {
    if (alarm.optBoolean("testAlarm", false) || (alarm.optJSONArray("days")?.length() ?: 0) > 0) {
      alarm.remove("oneShotDate")
      return
    }
    val existingDate = AlarmStore.existingOneShotDate(context, alarm)
    if (existingDate != null) {
      alarm.put("oneShotDate", existingDate)
      return
    }
    val next = nextTime(alarm, after)
      ?: throw IllegalArgumentException("A one-time alarm could not be scheduled.")
    alarm.put("oneShotDate", formatDate(next))
  }

  private fun formatDate(timestamp: Long): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US)
      .apply { timeZone = TimeZone.getDefault() }
      .format(Date(timestamp))

  private fun cancelBase(context: Context, alarmId: String) {
    val intent = Intent(context, AlarmReceiver::class.java).setAction(AlarmContract.ACTION_ALARM_FIRED)
    PendingIntent.getBroadcast(
      context,
      requestCode(alarmId, "base"),
      intent,
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.let { exactAlarmManager(context).cancel(it); it.cancel() }
  }

  private fun cancelRearm(context: Context, alarmId: String) {
    val intent = Intent(context, AlarmReceiver::class.java).setAction(AlarmContract.ACTION_REARM_FIRED)
    PendingIntent.getBroadcast(
      context,
      requestCode(alarmId, "rearm"),
      intent,
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    )?.let { exactAlarmManager(context).cancel(it); it.cancel() }
  }

  private fun rearmPendingIntent(context: Context, alarmId: String): PendingIntent {
    val intent = Intent(context, AlarmReceiver::class.java)
      .setAction(AlarmContract.ACTION_REARM_FIRED)
      .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
    return PendingIntent.getBroadcast(
      context,
      requestCode(alarmId, "rearm"),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun launchPendingIntent(context: Context): PendingIntent {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(context, ChallengeActivity::class.java)
    return PendingIntent.getActivity(
      context,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun exactAlarmManager(context: Context) = context.getSystemService(AlarmManager::class.java)
    ?: throw IllegalStateException("Android AlarmManager is unavailable.")

  private fun requestCode(alarmId: String, kind: String) = "$kind:$alarmId".hashCode()

  const val TEST_ALARM_ID = "__wayykup_test_alarm__"
}
