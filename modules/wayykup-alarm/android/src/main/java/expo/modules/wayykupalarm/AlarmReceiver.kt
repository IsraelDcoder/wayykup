package expo.modules.wayykupalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import androidx.core.content.ContextCompat

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val alarmId: String
    val alarm: JSONObject
    val scheduledAt: Long
    val occurrenceId: String
    val timeZone: String
    if (intent.action == AlarmContract.ACTION_REARM_FIRED) {
      alarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID) ?: return
      alarm = AlarmStore.readAlarms(context)[alarmId] ?: return
      val pending = AlarmStore.getPendingRing(context)
      scheduledAt = pending?.get("scheduledAt") as? Long ?: System.currentTimeMillis()
      occurrenceId = pending?.get("occurrenceId") as? String ?: AlarmStore.occurrenceId(alarmId, scheduledAt)
      timeZone = pending?.get("timeZone") as? String ?: java.util.TimeZone.getDefault().id
    } else {
      val rawAlarm = intent.getStringExtra(AlarmContract.EXTRA_ALARM) ?: return
      alarm = JSONObject(rawAlarm)
      alarmId = alarm.optString("id")
      scheduledAt = intent.getLongExtra(AlarmContract.EXTRA_SCHEDULED_AT, System.currentTimeMillis())
      occurrenceId = intent.getStringExtra(AlarmContract.EXTRA_OCCURRENCE_ID)
        ?: AlarmStore.occurrenceId(alarmId, scheduledAt)
      timeZone = intent.getStringExtra(AlarmContract.EXTRA_TIME_ZONE) ?: java.util.TimeZone.getDefault().id
      val repeatDays = alarm.optJSONArray("days") ?: org.json.JSONArray()
      if (!alarm.optBoolean("testAlarm", false) && repeatDays.length() > 0) {
        try {
          AlarmScheduler.scheduleNext(context, alarm, scheduledAt)
        } catch (error: Exception) {
          Log.e("WayykupAlarm", "event=repeat_alarm_reschedule_failed alarmId=$alarmId", error)
          context.sendBroadcast(Intent(AlarmContract.ACTION_HEALTH_CHANGED).setPackage(context.packageName))
        }
      } else {
        try {
          AlarmStore.markOneShotFired(context, alarm)
        } catch (error: Exception) {
          Log.e("WayykupAlarm", "event=one_shot_state_persist_failed alarmId=$alarmId", error)
        }
      }
    }

    if (AlarmStore.isOccurrenceDismissed(context, occurrenceId)) {
      Log.i("WayykupAlarm", "event=duplicate_dismissed_occurrence_ignored alarmId=$alarmId occurrenceId=$occurrenceId")
      return
    }

    val serviceIntent = Intent(context, RingService::class.java)
      .setAction(RingService.ACTION_START)
      .putExtra(AlarmContract.EXTRA_ALARM, alarm.toString())
      .putExtra(AlarmContract.EXTRA_SCHEDULED_AT, scheduledAt)
      .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
      .putExtra(AlarmContract.EXTRA_OCCURRENCE_ID, occurrenceId)
      .putExtra(AlarmContract.EXTRA_TIME_ZONE, timeZone)
      .putExtra(AlarmContract.EXTRA_IS_REARM, intent.action == AlarmContract.ACTION_REARM_FIRED)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ContextCompat.startForegroundService(context, serviceIntent)
      } else {
        context.startService(serviceIntent)
      }
    } catch (error: Exception) {
      Log.e("WayykupAlarm", "event=failed_to_start_ring_service alarmId=$alarmId", error)
      throw error
    }
  }
}
