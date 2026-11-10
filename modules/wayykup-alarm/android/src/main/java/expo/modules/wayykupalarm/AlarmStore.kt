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
  private const val KEY_QUEUED_RINGS = "queued_rings"
  private const val KEY_TEST_PASSED = "test_alarm_passed"
  private const val KEY_CONSUMED_ONE_SHOTS = "consumed_one_shot_alarms"
  private const val KEY_DISMISSED_OCCURRENCES = "dismissed_occurrences"

  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(AlarmContract.PREFS, Context.MODE_PRIVATE)

  fun saveAlarm(context: Context, alarm: JSONObject) {
    val alarms = readAlarms(context)
    val alarmId = alarm.getString("id")
    val previous = alarms[alarmId]
    val consumed = consumedOneShots(context)
    if (previous == null || scheduleSignature(previous) != scheduleSignature(alarm)) consumed.remove(alarmId)
    alarms[alarmId] = alarm
    prefs(context).edit()
      .putString(KEY_ALARMS, JSONObject(alarms as Map<*, *>).toString())
      .putString(KEY_CONSUMED_ONE_SHOTS, consumed.toString())
      .apply()
  }

  fun removeAlarm(context: Context, alarmId: String) {
    val alarms = readAlarms(context)
    alarms.remove(alarmId)
    val consumed = consumedOneShots(context).apply { remove(alarmId) }
    prefs(context).edit()
      .putString(KEY_ALARMS, JSONObject(alarms as Map<*, *>).toString())
      .putString(KEY_CONSUMED_ONE_SHOTS, consumed.toString())
      .apply()
  }

  fun readAlarms(context: Context): MutableMap<String, JSONObject> {
    val result = mutableMapOf<String, JSONObject>()
    val raw = prefs(context).getString(KEY_ALARMS, null) ?: return result
    val parsed = JSONObject(raw)
    parsed.keys().forEach { key -> result[key] = parsed.getJSONObject(key) }
    return result
  }

  fun isOneShotConsumed(context: Context, alarm: JSONObject): Boolean {
    if (alarm.optBoolean("testAlarm", false) || (alarm.optJSONArray("days")?.length() ?: 0) > 0) return false
    return consumedOneShots(context).optString(alarm.optString("id")) == scheduleSignature(alarm)
  }

  fun existingOneShotDate(context: Context, alarm: JSONObject): String? {
    val existing = readAlarms(context)[alarm.optString("id")] ?: return null
    if (scheduleSignature(existing) != scheduleSignature(alarm)) return null
    return existing.optString("oneShotDate").takeIf { it.isNotBlank() }
  }

  fun markOneShotFired(context: Context, alarm: JSONObject) {
    if (alarm.optBoolean("testAlarm", false) || (alarm.optJSONArray("days")?.length() ?: 0) > 0) return
    val consumed = consumedOneShots(context)
      .put(alarm.optString("id"), scheduleSignature(alarm))
    check(prefs(context).edit().putString(KEY_CONSUMED_ONE_SHOTS, consumed.toString()).commit()) {
      "Wayykup could not persist that a one-time alarm has fired."
    }
  }

  private fun consumedOneShots(context: Context): JSONObject {
    val raw = prefs(context).getString(KEY_CONSUMED_ONE_SHOTS, null) ?: return JSONObject()
    return JSONObject(raw)
  }

  private fun scheduleSignature(alarm: JSONObject): String =
    "${alarm.optString("time")}|${alarm.optJSONArray("days") ?: JSONArray()}"

  fun savePendingRing(
    context: Context,
    alarm: JSONObject,
    occurrenceId: String,
    at: Long,
    scheduledAt: Long,
    timeZone: String,
    isRearm: Boolean,
  ) {
    val previous = prefs(context).getString(KEY_PENDING_RING, null)?.let(::JSONObject)
    val sameOccurrence = previous != null
      && previous.optString("alarmId") == alarm.optString("id")
      && previous.optString("occurrenceId") == occurrenceId
    val previousState = previous?.optString("state", "ringing") ?: "ringing"
    val state = if (sameOccurrence && !isRearm) previousState else "ringing"
    val ring = JSONObject()
      .put("alarmId", alarm.getString("id"))
      .put("occurrenceId", occurrenceId)
      .put("at", at)
      .put("scheduledAt", scheduledAt)
      .put("timeZone", timeZone)
      .put("challenge", alarm.optString("task", "Shake Your Phone"))
      .put("sound", alarm.optString("sound", "police_siren"))
      .put("testAlarm", alarm.optBoolean("testAlarm", false))
      .put("state", state)
      .put("snoozed", false)
      .put("rearmAt", 0L)
    check(prefs(context).edit().putString(KEY_PENDING_RING, ring.toString()).commit()) {
      "Wayykup could not persist the active alarm occurrence."
    }
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
      "challenge" to ring.optString("challenge", "Shake Your Phone"),
      "sound" to ring.optString("sound", "police_siren"),
      "testAlarm" to ring.optBoolean("testAlarm", false),
      "state" to ring.optString("state", "ringing"),
      "snoozed" to ring.optBoolean("snoozed", false),
      "rearmAt" to ring.optLong("rearmAt", 0L)
    )
  }

  fun activateChallenge(context: Context, alarmId: String, occurrenceId: String) {
    val preferences = prefs(context)
    val raw = preferences.getString(KEY_PENDING_RING, null)
      ?: throw IllegalStateException("The alarm occurrence is no longer active.")
    val ring = JSONObject(raw)
    require(ring.optString("alarmId") == alarmId && ring.optString("occurrenceId") == occurrenceId) {
      "The active alarm does not match this challenge."
    }
    val state = ring.optString("state", "ringing")
    if (state == "challenge_active") return
    require(state == "ringing" || state == "challenge_pending") {
      "This alarm occurrence cannot start its challenge from state $state."
    }
    ring.put("state", "challenge_pending")
    check(preferences.edit().putString(KEY_PENDING_RING, ring.toString()).commit()) {
      "Wayykup could not save the pending challenge state."
    }
    ring.put("state", "challenge_active")
    check(preferences.edit().putString(KEY_PENDING_RING, ring.toString()).commit()) {
      "Wayykup could not save the active challenge state."
    }
  }

  fun markChallengeCompleted(context: Context, alarmId: String, occurrenceId: String) {
    val preferences = prefs(context)
    val raw = preferences.getString(KEY_PENDING_RING, null)
      ?: throw IllegalStateException("The alarm occurrence is no longer active.")
    val ring = JSONObject(raw)
    require(ring.optString("alarmId") == alarmId && ring.optString("occurrenceId") == occurrenceId) {
      "The active alarm does not match this completed challenge."
    }
    val state = ring.optString("state")
    if (state == "challenge_completed" || state == "dismissed") return
    require(state == "challenge_active") {
      "The challenge must be active before it can be completed."
    }
    ring.put("state", "challenge_completed")
    check(preferences.edit().putString(KEY_PENDING_RING, ring.toString()).commit()) {
      "Wayykup could not persist challenge completion."
    }
  }

  fun markDismissed(context: Context, alarmId: String, occurrenceId: String): Boolean {
    val preferences = prefs(context)
    val raw = preferences.getString(KEY_PENDING_RING, null) ?: return false
    val ring = JSONObject(raw)
    if (ring.optString("alarmId") != alarmId || ring.optString("occurrenceId") != occurrenceId) return false
    if (ring.optString("state") == "dismissed") return true
    if (ring.optString("state") != "challenge_completed") return false
    ring.put("state", "dismissed")
    val dismissed = preferences.getStringSet(KEY_DISMISSED_OCCURRENCES, emptySet())
      ?.toMutableSet() ?: mutableSetOf()
    dismissed.add(occurrenceId)
    check(
      preferences.edit()
        .putString(KEY_PENDING_RING, ring.toString())
        .putStringSet(KEY_DISMISSED_OCCURRENCES, dismissed)
        .commit()
    ) { "Wayykup could not persist alarm dismissal." }
    return true
  }

  fun isOccurrenceDismissed(context: Context, occurrenceId: String): Boolean =
    prefs(context).getStringSet(KEY_DISMISSED_OCCURRENCES, emptySet())?.contains(occurrenceId) == true

  fun queueRing(
    context: Context,
    alarm: JSONObject,
    occurrenceId: String,
    scheduledAt: Long,
    timeZone: String,
    isRearm: Boolean,
  ) {
    val preferences = prefs(context)
    val queued = preferences.getString(KEY_QUEUED_RINGS, null)?.let(::JSONObject) ?: JSONObject()
    if (queued.has(occurrenceId)) return
    queued.put(
      occurrenceId,
      JSONObject()
        .put("alarm", alarm.toString())
        .put("scheduledAt", scheduledAt)
        .put("timeZone", timeZone)
        .put("isRearm", isRearm)
        .put("queuedAt", System.currentTimeMillis())
    )
    check(preferences.edit().putString(KEY_QUEUED_RINGS, queued.toString()).commit()) {
      "Wayykup could not queue the overlapping alarm occurrence."
    }
  }

  fun takeNextQueuedRing(context: Context): Map<String, Any?>? {
    val preferences = prefs(context)
    val queued = preferences.getString(KEY_QUEUED_RINGS, null)?.let(::JSONObject) ?: return null
    val nextId = queued.keys().asSequence()
      .minByOrNull { queued.optJSONObject(it)?.optLong("queuedAt", Long.MAX_VALUE) ?: Long.MAX_VALUE }
      ?: return null
    val next = queued.optJSONObject(nextId) ?: return null
    queued.remove(nextId)
    check(preferences.edit().putString(KEY_QUEUED_RINGS, queued.toString()).commit()) {
      "Wayykup could not remove a queued alarm occurrence."
    }
    return mapOf(
      "occurrenceId" to nextId,
      "alarm" to next.getString("alarm"),
      "scheduledAt" to next.getLong("scheduledAt"),
      "timeZone" to next.optString("timeZone", TimeZone.getDefault().id),
      "isRearm" to next.optBoolean("isRearm", false)
    )
  }

  fun removeQueuedAlarm(context: Context, alarmId: String) {
    val preferences = prefs(context)
    val queued = preferences.getString(KEY_QUEUED_RINGS, null)?.let(::JSONObject) ?: return
    val matchingIds = queued.keys().asSequence().filter { occurrenceId ->
      queued.optJSONObject(occurrenceId)?.optString("alarm")?.let(::JSONObject)?.optString("id") == alarmId
    }.toList()
    if (matchingIds.isEmpty()) return
    matchingIds.forEach(queued::remove)
    check(preferences.edit().putString(KEY_QUEUED_RINGS, queued.toString()).commit()) {
      "Wayykup could not cancel queued alarms for $alarmId."
    }
  }

  fun markPendingRingSnoozed(context: Context, alarmId: String, rearmAt: Long) {
    val preferences = prefs(context)
    val raw = preferences.getString(KEY_PENDING_RING, null) ?: return
    val ring = JSONObject(raw)
    if (ring.optString("alarmId") != alarmId) return
    ring.put("snoozed", true)
      .put("rearmAt", rearmAt)
    check(preferences.edit().putString(KEY_PENDING_RING, ring.toString()).commit()) {
      "Wayykup could not persist the snoozed alarm state."
    }
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
