package expo.modules.wayykupalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      AlarmScheduler.rescheduleAll(context)
      context.sendBroadcast(Intent(AlarmContract.ACTION_HEALTH_CHANGED).setPackage(context.packageName))
    } catch (error: Exception) {
      Log.e("WayykupAlarm", "event=reschedule_failed action=${intent.action}", error)
    }
  }
}
