package expo.modules.wayykupalarm

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object AlarmStore {
  private const val TAG = "WayykupAlarm"
  private const val KEY_ALARMS = "alarms"
  private const val KEY_PENDING_RING = "pending_ring"
  private const val KEY_TEST_PASSED = "test_alarm_passed"

  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(AlarmContract.PREFS, Context.MODE_PRIVATE)

  fun saveAlarm(context: Context, alarm: JSONObject) {
    val alarms = readAlarms(context)
    alarms.put(alarm.getString("id"), alarm)
    prefs(context).edit().putString(KEY_ALARMS, JSONObject(alarms as Map<*, *>).toString()).apply()
  }

  fun removeAlarm(context: Context, alarmId: String) {
    val alarms = readAlarms(context)
    alarms.remove(alarmId)
    prefs(context).edit().putString(KEY_ALARMS, JSONObject(alarms as Map<*, *>).toString()).apply()
  }

  fun readAlarms(context: Context): MutableMap<String, JSONObject> {
    val result = mutableMapOf<String, JSONObject>()
    val raw = prefs(context).getString(KEY_ALARMS, null) ?: return result
    val parsed = JSONObject(raw)
    parsed.keys().forEach { key -> result[key] = parsed.getJSONObject(key) }
    return result
  }

  fun savePendingRing(
    context: Context,
    alarm: JSONObject,
    occurrenceId: String,
    at: Long,
    scheduledAt: Long,
    timeZone: String,
  ) {
    val ring = JSONObject()
      .put("alarmId", alarm.getString("id"))
      .put("occurrenceId", occurrenceId)
      .put("at", at)
      .put("scheduledAt", scheduledAt)
      .put("timeZone", timeZone)
      .put("challenge", alarm.optString("task", "Math"))
      .put("sound", alarm.optString("sound", "Air raid"))
      .put("testAlarm", alarm.optBoolean("testAlarm", false))
    prefs(context).edit().putString(KEY_PENDING_RING, ring.toString()).apply()
    Log.i(
      TAG,
      "event=ringStarted alarmId=${alarm.optString("id")} occurrenceId=$occurrenceId at=$at scheduledAt=$scheduledAt device=${Build.MANUFACTURER}/${Build.MODEL} android=${Build.VERSION.RELEASE}"
    )
  }

  fun getPendingRing(context: Context): Map<String, Any?>? {
    val value = prefs(context).getString(KEY_PENDING_RING, null) ?: return null
    val ring = JSONObject(value)
    return mapOf(
      "alarmId" to ring.getString("alarmId"),
      "occurrenceId" to ring.getString("occurrenceId"),
      "at" to ring.getLong("at"),
      "scheduledAt" to ring.getLong("scheduledAt"),
      "timeZone" to ring.optString("timeZone", TimeZone.getDefault().id),
      "challenge" to ring.optString("challenge", "Math"),
      "sound" to ring.optString("sound", "Air raid"),
      "testAlarm" to ring.optBoolean("testAlarm", false)
    )
  }

  fun clearPendingRing(context: Context) {
    prefs(context).edit().remove(KEY_PENDING_RING).apply()
  }

  fun occurrenceId(alarmId: String, timestamp: Long): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    formatter.timeZone = TimeZone.getDefault()
    return "$alarmId:${formatter.format(Date(timestamp))}"
  }

  fun chain(context: Context, alarmId: String): Pair<Long, Int> {
    val p = prefs(context)
    return p.getLong("chain_started_$alarmId", 0L) to p.getInt("chain_count_$alarmId", 0)
  }

  fun updateChain(context: Context, alarmId: String, startedAt: Long, count: Int) {
    prefs(context).edit()
      .putLong("chain_started_$alarmId", startedAt)
      .putInt("chain_count_$alarmId", count)
      .apply()
  }

  fun clearChain(context: Context, alarmId: String) {
    prefs(context).edit()
      .remove("chain_started_$alarmId")
      .remove("chain_count_$alarmId")
      .apply()
  }

  fun testAlarmPassed(context: Context): Boolean =
    prefs(context).getBoolean(KEY_TEST_PASSED, false)

  fun resetTestAlarm(context: Context) {
    prefs(context).edit().putBoolean(KEY_TEST_PASSED, false).apply()
  }

  fun markTestAlarmPassed(context: Context) {
    prefs(context).edit().putBoolean(KEY_TEST_PASSED, true).apply()
  }
}
