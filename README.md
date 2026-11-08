# Wayykup

Wayykup is an Expo / React Native alarm app prototype with an onboarding flow, a hard paywall, alarm management, and wake-up challenges.

## Run locally

```sh
npm install
npm run android
```

Wayykup's alarm layer is a local Expo module. **Expo Go is not supported for alarm testing.** Use an EAS development build or a locally generated native project. Android builds need Android Studio/SDK; iOS builds require macOS and Xcode.

```sh
# Install and launch a local Android development build
npm run android

# Or build an installable development client with EAS
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest build --profile development --platform ios
npm run start:dev
```

The app also uses native modules for on-device object recognition, accelerometer input, audio, RevenueCat, and Mixpanel.

Copy `.env.example` to `.env` and add the public SDK keys for the relevant platforms. RevenueCat needs an offering containing `WEEKLY` and `ANNUAL` packages and an active entitlement named `savage_plus`. Configure the annual product's seven-day introductory trial in App Store Connect / Play Console and RevenueCat. The app does not contain store credentials.

The development build offers a clearly labeled preview path when no RevenueCat key is set. Release builds do not bypass the paywall if billing is unconfigured.

## Native alarm behavior and limits

- Android schedules exact alarms with `AlarmManager.setAlarmClock()` and rings from a native foreground service using `USAGE_ALARM`, a wake lock, a high-importance alarm notification, and a lock-screen challenge launch. Pending schedules are restored after reboot, app replacement, clock changes, time-zone changes, and exact-alarm permission changes.
- On iOS 26+, the module schedules with AlarmKit and includes a WidgetKit extension for the Live Activity presentation. On earlier iOS versions it uses time-sensitive local notification chains; this fallback is intentionally labeled reduced-reliability and is not equivalent to AlarmKit.
- AlarmKit and Android permissions, full-screen access, and notification permission are checked before scheduling. A first-use 60-second test ring must be completed before personal alarms are scheduled.
- Android does not request battery-optimization exemption. The app reports battery restrictions and directs users to system settings; OEM-specific behavior still needs physical-device testing.
- No local alarm architecture can override a user's denied OS permissions or guarantee identical behavior across all OEM power managers. Test on a development or release build, never Expo Go.
- Android writes ring starts and terminal events directly to `wayykup-stats.db`, even when JavaScript is unavailable. iOS AlarmKit intents write ring state when the system action runs; the pre-iOS-26 notification fallback is reduced-reliability. Android device logs use the `WayykupAlarm` tag.
- QR challenges require linking the physical code in alarm settings. Shake challenges use the device accelerometer. Memory challenges reveal a short sequence, then require the user to enter it.
- Object Hunt lets users select household targets. At alarm time Wayykup shuffles one target, takes a camera photo when the user taps the capture button, and checks its labels on-device (bundled ML Kit image labeling on Android and Apple Vision on iOS). A supported label at 25% confidence or higher displays a green “OBJECT RECOGNIZED” checkmark and completes the challenge. An unrecognized photo keeps the alarm active and can be retried. The built-in classifiers support common labels, not every variation or brand; adequate lighting and a clear view of the target improve recognition.
- The selected object, onboarding progress, and alarm-audio preference are saved locally. The audio preference controls Wayykup's in-app player; operating-system notification audio may continue independently.
- Alarm sounds cannot raise the device's hardware volume. Savage mode increases the in-app player volume after a snooze; notification volume remains controlled by the operating system.
- Alarm sounds can be selected from local audio files in the alarm editor. Wayykup copies selected files into app-private storage so the native alarm can access them after the picker closes; streaming or DRM-protected tracks are not available through the file picker. Custom sound playback must be verified in a native development build on each target platform.

## Validation

```sh
npm run typecheck
npm run lint
npx expo prebuild --platform android
```

`expo prebuild` and physical-device alarm tests must be run on the developer's build machine. The 5-second latency and overnight reliability matrix are not certified until the required Android OEMs and iOS 25/26 devices have been exercised. See [the diagnosis](./docs/native-alarm-diagnosis.md) and [device validation report](./docs/native-alarm-device-validation.md).

### Android alarm debugging

Run these commands from a machine with Android Platform Tools installed:

```sh
adb shell dumpsys alarm | grep com.wayykup.app
adb shell cmd deviceidle force-idle
adb shell cmd appops set com.wayykup.app SCHEDULE_EXACT_ALARM deny
adb logcat -s WayykupAlarm
```

The last two commands deliberately alter device state; restore the app's exact-alarm permission in Android Settings before testing again. Declare `USE_EXACT_ALARM` as an alarm-clock app in the Google Play Console as required by Play policy.
