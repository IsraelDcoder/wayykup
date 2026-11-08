# Native alarm diagnosis

## Finding

The failed five-minute test is consistent with two issues in the previous alarm path:

1. The previous app scheduled alarms through `expo-notifications`. The permission request could return `false`, in which case the app did not schedule the notification. The reported device state was that notification permission was denied.
2. The app ran in Expo Go. Expo Go does not contain Wayykup's custom native alarm module, and JavaScript/audio started by the app cannot provide a reliable lock-screen or killed-app alarm.

The first is the likely immediate reason that no notification appeared on that test. The second means that even a successful notification test would not establish reliable alarm behavior.

## Evidence and limits

- The previous app code path used Expo Notifications for alarm scheduling and waited until JavaScript opened the challenge screen before starting the custom audio.
- The permission state reported for the tested device was denied.
- No `adb logcat`, `dumpsys alarm`, iOS device log, or screen recording from the failed run was available. Therefore, there is no captured OS log proving whether Android received a scheduled request or suppressed delivery. The diagnosis is source- and report-based, not a device-log-confirmed root cause.

## Current implementation status

Alarm scheduling and ringing have been moved to a local Expo native module. Expo Go is explicitly unsupported; a development or release build is required. Android source uses `AlarmManager.setAlarmClock()` and a foreground ring service. iOS 26+ source uses AlarmKit; earlier iOS versions use an explicitly reduced-reliability notification fallback.

The native project has not been built in this environment. Physical-device testing is still required before treating the alarm as reliable.
