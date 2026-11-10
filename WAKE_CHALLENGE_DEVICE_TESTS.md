# Wake-up challenge and alarm device checklist

These are physical-device checks; simulator and web results do not certify speech recognition, camera pose/object detection, alarm audio isolation, or locked-device behavior.

## Required devices and conditions

- [ ] Low-end Android phone 1 (record manufacturer/model, Android version, RAM).
- [ ] Low-end Android phone 2 (a different manufacturer/model; record Android version and RAM).
- [ ] Older supported iPhone (record model and iOS version).
- [ ] Wired headset connected, then disconnected.
- [ ] Bluetooth headset connected, then disconnected.
- [ ] Loud room with continuous background sound.
- [ ] Quiet room.

## Android alarm reliability

- [ ] Schedule a repeating alarm, close Wayykup from Recents, lock the device, and verify it rings on time with the app process absent.
- [ ] Verify the normal ringing screen appears first; the configured challenge starts only after swiping right on the ringing screen, and the alarm continues until the task is completed.
- [ ] Start with the alarm-stream volume low; verify ringing temporarily raises it, challenge failures raise the native Android alarm volume tier, and the original setting is restored after successful completion.
- [ ] Reboot before a scheduled alarm and verify enabled alarms are restored after unlock; verify one-time alarms do not repeat the following day after firing.
- [ ] Change the device time and time zone with alarms scheduled; verify future alarms are re-armed once at their intended local time and no duplicate rings are created.
- [ ] Revoke exact-alarm, notification, or full-screen-intent access and verify Wayykup reports which permission is missing instead of claiming the alarm is ready.
- [ ] Apply manufacturer battery restrictions on both Android phones and record whether alarms ring on time and what battery-setting guidance is needed.
- [ ] Repeat tests with screen locked and the app swiped away. Do not treat Android's explicit **Force stop** action as an ordinary close; the OS suppresses app alarms until the user launches the app again.

## Alarm ring-to-dismiss flow

Run each case on at least two physical Android devices and capture the alarm occurrence ID, Android version, ring latency, and outcome:

| Case | Expected result | Execution result |
|---|---|---|
| App open at ring time | Native audio starts; the normal ringing screen appears before the configured challenge. | Not run here: no Android SDK/device attached. |
| Swipe to stop | Right swipe opens the configured challenge; it does not stop audio or dismiss the occurrence. | Not run here: no Android SDK/device attached. |
| App minimized during challenge | Native audio continues; returning to Wayykup restores the active challenge. | Not run here: no Android SDK/device attached. |
| App swiped away from Recents | Native audio rings and the ringing interface can be reopened; challenge state is preserved. | Not run here: no Android SDK/device attached. |
| Phone locked at ring time | Native audio rings; the lock-screen launch presents the normal ringing screen before the challenge. | Not run here: no Android SDK/device attached. |
| Challenge abandoned | Backgrounding or closing the challenge UI does not complete or dismiss the occurrence; reopening restores the active challenge. | Not run here: no Android SDK/device attached. |
| Incorrect challenge | The alarm remains audible and the same challenge remains active. | Not run here: no Android SDK/device attached. |
| Correct challenge | Native occurrence transitions active → completed → dismissed; audio/service stop and the Good Morning success screen appears. | Not run here: no Android SDK/device attached. |
| Duplicate ring or completion for the same occurrence | Native state prevents a second active ring and rejects stale or duplicate completion without affecting another occurrence. | Not run here: no Android SDK/device attached. |
| iOS app closed or phone locked | AlarmKit/notification behavior, ring audio, and access to the normal ringing screen are verified on a supported iPhone. | Not run here: no iOS device/build available. |

## Yell to Stop

- [ ] Grant microphone and speech permissions when beginning the challenge; verify denial leaves the alarm active and offers a retry without a dismissal bypass.
- [ ] Verify iOS and Android only accept the selected phrase through on-device speech recognition; missing offline speech support must show a retryable error.
- [ ] Say the selected phrase clearly; verify one valid recognition completes the challenge exactly once.
- [ ] Say a different phrase, make unrelated noise, and allow recognition to fail; verify the challenge stays active and the alarm continues.
- [ ] Test each supported phrase, quiet and noisy rooms, and wired/Bluetooth headset routing.
- [ ] Background Wayykup while recognition is active; verify recognition stops, the alarm continues, and returning requires an explicit retry.
- [ ] Verify no audio recording, raw audio, or speech transcript is persisted or sent to analytics.
- [ ] Test permission revocation, unavailable speech service, and missing offline model; verify a clear error and no challenge completion.

## Push-up Challenge

- [ ] Grant camera access and verify the live view is side-on, includes the full body, and does not save or upload images.
- [ ] Verify a complete, aligned lower-and-extend cycle increments the count once; initial extended pose, partial reps, poor alignment, obscured landmarks, and low-confidence poses do not count.
- [ ] Verify the configured repetition target is required and alarm audio continues until it is met.
- [ ] Background the app during capture; verify camera sampling stops, the alarm continues, and returning restores the active challenge without resetting it or completing it.
- [ ] Test iOS Vision and Android ML Kit pose detection on actual devices, including low light and varied body positions.

## Legacy challenge migration

- [ ] Verify each retired challenge alarm is retained with its time, repeat days, sound, label, enabled state, and unrelated settings.
- [ ] Verify retired challenge alarms have no replacement assigned, are canceled natively, and require explicit selection of one of the four supported challenges before rescheduling.
- [ ] Verify supported historical aliases for Yell, Shake, Push-ups, and Object Hunt migrate to their matching current task without losing their compatible configuration.
- [ ] Verify legacy alarms are not discarded when their challenge configuration is absent.

## Release gate

- [ ] Run unit tests for the four-challenge registry, push-up pose state machine, shake detection, object matching, alarm migration, and alarm lifecycle transitions.
- [ ] Build Android and iOS development builds successfully.
- [ ] Run all listed physical-device cases; this repository's current Windows environment cannot certify iOS or locked-device behavior.
- [ ] Re-run alarm audio and speech-recognition interaction checks after any native audio or alarm-service change.
