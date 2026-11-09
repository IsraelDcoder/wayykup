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
    if (!alarm.optBoolean("enabled", true)) {
      cancel(context, alarmId, removeDefinition = true)
      return
    }
    if (AlarmHealth.get(context)["canSchedule"] != true) {
      throw SecurityException("Allow Wayykup to schedule exact alarms before scheduling this alarm.")
    }
    AlarmStore.saveAlarm(context, alarm)
    cancelBase(context, alarmId)
    scheduleNext(context, alarm, System.currentTimeMillis())
    Log.i(TAG, "event=scheduled alarmId=$alarmId device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}")
  }

  fun cancel(context: Context, alarmId: String, removeDefinition: Boolean) {
    cancelBase(context, alarmId)
    cancelRearm(context, alarmId)
    context.stopService(Intent(context, RingService::class.java).putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId))
    AlarmStore.clearChain(context, alarmId)
    if (removeDefinition) AlarmStore.removeAlarm(context, alarmId)
  }

  fun cancelChain(context: Context, alarmId: String) {
    cancelRearm(context, alarmId)
    AlarmStore.clearChain(context, alarmId)
    context.startService(
      Intent(context, RingService::class.java)
        .setAction(AlarmContract.ACTION_SERVICE_COMPLETED)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
    )
  }

  fun rearm(context: Context, alarmId: String, delayMs: Long = REARM_DELAY_MS) {
    val (startedAt, count) = AlarmStore.chain(context, alarmId)
    val chainStart = if (startedAt == 0L) System.currentTimeMillis() else startedAt
    if (System.currentTimeMillis() - chainStart >= REARM_LIMIT_MS || count >= 24) {
      val occurrenceId = AlarmStore.getPendingRing(context)?.get("occurrenceId") as? String
      if (occurrenceId != null) OccurrenceWriter.resolve(context, occurrenceId, "bypassed")
      AlarmStore.clearChain(context, alarmId)
      cancelRearm(context, alarmId)
      return
    }
    val nextCount = count + 1
    AlarmStore.updateChain(context, alarmId, chainStart, nextCount)
    val pendingIntent = rearmPendingIntent(context, alarmId)
    val at = System.currentTimeMillis() + delayMs.coerceIn(60_000L, 300_000L)
    exactAlarmManager(context).setAlarmClock(
      AlarmManager.AlarmClockInfo(at, launchPendingIntent(context)),
      pendingIntent
    )
    AlarmStore.getPendingRing(context)?.let { ring ->
      OccurrenceWriter.updateRearms(context, ring["occurrenceId"] as String, nextCount)
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
      .put("task", "Math")
      .put("sound", "Air raid")
      .put("mathDifficulty", "Easy")
      .put("testAlarm", true)
    AlarmStore.saveAlarm(context, alarm)
    scheduleAt(context, alarm, at)
    Log.i(
      TAG,
      "event=test_alarm_scheduled alarmId=${alarm.optString("id")} fireAt=$at delayMs=${at - System.currentTimeMillis()} device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}"
    )
  }

  fun scheduleNext(context: Context, alarm: JSONObject, after: Long) {
    val next = nextTime(alarm, after) ?: return
    scheduleAt(context, alarm, next)
  }

  fun rescheduleAll(context: Context) {
    val now = System.currentTimeMillis()
    AlarmStore.readAlarms(context).values.forEach { alarm ->
      cancelBase(context, alarm.optString("id"))
      if (alarm.optBoolean("enabled", true)) scheduleNext(context, alarm, now)
    }
    Log.i(TAG, "event=rescheduled count=${AlarmStore.readAlarms(context).size}")
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
