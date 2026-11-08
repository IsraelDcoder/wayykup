package expo.modules.wayykupalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class AlarmActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != AlarmContract.ACTION_SYSTEM_STOP) return
    val alarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID) ?: return
    ContextCompat.startForegroundService(
      context,
      Intent(context, RingService::class.java)
        .setAction(AlarmContract.ACTION_SERVICE_REARM)
        .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
        .putExtra(AlarmContract.EXTRA_DELAY_MS, 75_000L)
    )
  }
}
