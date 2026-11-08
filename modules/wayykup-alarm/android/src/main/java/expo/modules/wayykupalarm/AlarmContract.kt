package expo.modules.wayykupalarm

internal object AlarmContract {
  const val ACTION_RING_STARTED = "com.wayykup.alarm.RING_STARTED"
  const val ACTION_ALARM_FIRED = "com.wayykup.alarm.ALARM_FIRED"
  const val ACTION_REARM_FIRED = "com.wayykup.alarm.REARM_FIRED"
  const val ACTION_SYSTEM_STOP = "com.wayykup.alarm.SYSTEM_STOP"
  const val ACTION_CHALLENGE_COMPLETED = "com.wayykup.alarm.CHALLENGE_COMPLETED"
  const val ACTION_HEALTH_CHANGED = "com.wayykup.alarm.HEALTH_CHANGED"
  const val ACTION_SERVICE_REARM = "com.wayykup.alarm.SERVICE_REARM"
  const val ACTION_SERVICE_COMPLETED = "com.wayykup.alarm.SERVICE_COMPLETED"
  const val EXTRA_ALARM = "alarmJson"
  const val EXTRA_ALARM_ID = "alarmId"
  const val EXTRA_OCCURRENCE_ID = "occurrenceId"
  const val EXTRA_SCHEDULED_AT = "scheduledAt"
  const val EXTRA_TIME_ZONE = "timeZone"
  const val EXTRA_CHAIN_STARTED_AT = "chainStartedAt"
  const val EXTRA_REARM_COUNT = "rearmCount"
  const val EXTRA_DELAY_MS = "delayMs"
  const val CHANNEL_ID = "wayykup-native-alarm"
  const val PREFS = "wayykup_native_alarms"
}
