package expo.modules.wayykupalarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

internal object AlarmHealth {
  fun get(context: Context): Map<String, Any?> {
    val alarmManager = context.getSystemService(AlarmManager::class.java)
    val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager?.canScheduleExactAlarms() == true
    val notifications = NotificationManagerCompat.from(context).areNotificationsEnabled()
    val fullScreen = Build.VERSION.SDK_INT < 34 ||
      context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() == true
    val batteryRestricted =
      context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) != true
    val canRing = exact && notifications && fullScreen
    return mapOf(
      "authorized" to (exact && notifications),
      "exactAlarm" to exact,
      "fullScreenIntent" to fullScreen,
      "notifications" to notifications,
      "batteryRestricted" to batteryRestricted,
      "canRingNow" to canRing,
      "platform" to "android",
      "testAlarmPassed" to AlarmStore.testAlarmPassed(context),
      "deviceModel" to "${Build.MANUFACTURER} ${Build.MODEL}",
      "osVersion" to "Android ${Build.VERSION.RELEASE}",
      "reliability" to "native"
    )
  }

  fun openPermissionSettings(context: Context) {
    val health = get(context)
    val exact = health["exactAlarm"] == true
    val fullScreen = health["fullScreenIntent"] == true
    when {
      !exact && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> openSettings(context, "exactAlarm")
      !fullScreen && Build.VERSION.SDK_INT >= 34 -> openSettings(context, "fullScreenIntent")
      else -> openSettings(context, "battery")
    }
  }

  fun openSettings(context: Context, kind: String) {
    val intent = when (kind) {
      "exactAlarm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      }
      "fullScreenIntent" -> if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      }
      "battery" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
    }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }
}
