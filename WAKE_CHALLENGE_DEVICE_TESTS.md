# Yell to Wake and Face Challenge device checklist

These are physical-device checks; simulator and web results do not certify microphone routing, camera performance, alarm audio isolation, or locked-device behavior.

## Required devices and conditions

- [ ] Low-end Android phone 1 (record manufacturer/model, Android version, RAM).
- [ ] Low-end Android phone 2 (a different manufacturer/model; record Android version and RAM).
- [ ] Older supported iPhone (record model and iOS version).
- [ ] Wired headset connected, then disconnected.
- [ ] Bluetooth headset connected, then disconnected.
- [ ] Loud room with continuous background sound.
- [ ] Quiet room.

## Yell to Wake

- [ ] Grant microphone permission while selecting the challenge; verify the rationale appears before the OS prompt.
- [ ] Deny permission, then ring the alarm: verify the selected fallback starts and `challenge_permission_denied` is emitted without recording media.
- [ ] Grant permission, then revoke it in system settings before ringing: verify fallback starts without a dead end.
- [ ] Use **Try it now** in quiet conditions; confirm calibration lasts about 1.5 seconds and progress requires sustained vocalization.
- [ ] Repeat in the loud room in both Loud and Whisper modes; ordinary room noise, taps, blowing, and short vocal spikes must not complete the challenge.
- [ ] Verify the device's own alarm audio cannot raise Yell progress or complete it. Repeat with custom and bundled alarm sounds.
- [ ] Verify the alarm fades back in after no progress, ducks again while the user is above target, and still escalates correctly after snooze.
- [ ] Verify the displayed score is 0–100 only; no dBFS, samples, recording files, or raw audio appear in app storage, logs, or analytics.
- [ ] Test wired and Bluetooth headset routing. Confirm the built-in microphone is selected or the UI clearly tells the user which microphone is active.
- [ ] Test challenge completion, 3-minute timeout, **Can't do this right now**, and microphone resource failure; each must start the chosen fallback and emit one fallback event.
- [ ] Launch from the alarm notification/full-screen intent on Android 14+; confirm microphone access is only active while the challenge screen is foregrounded.

## Face Challenge

- [ ] Build and install an EAS/development build (not Expo Go); verify camera rationale and setup permission request.
- [ ] Deny camera permission, revoke it after setup, and simulate unavailable camera hardware; verify the selected fallback starts.
- [ ] Complete **Try it now** using a live face. Confirm three gestures are randomly ordered, each requires a neutral-to-gesture transition, and a new sequence is generated after a timed-out attempt.
- [ ] Hold a smile and present a still photo; neither must complete the three-gesture sequence.
- [ ] Test smile, two distinct blinks, left/right turns, and open-mouth detection under bright, dim, and uneven lighting.
- [ ] Keep the face out of frame for 4 seconds: verify the low-light hint and screen fill. Keep it absent for 2 minutes: verify fallback.
- [ ] Lock the device before the alarm, then unlock as requested if the camera cannot start from the lock screen; confirm the alarm remains active and a clear fallback/unlock route is available.
- [ ] Verify frame processing is responsive at approximately 8 fps or better on both low-end Android phones; inspect CPU use, battery drain, thermal behavior, and memory over a long attempt.
- [ ] Confirm the camera session and brightness are restored on completion, fallback, permission failure, navigation, and app backgrounding.
- [ ] Confirm analytics contain only challenge metadata and the gesture sequence, never frames, landmarks, face measurements, or identity data.
- [ ] Test timeout, **Can't do this right now**, camera failure, and low-light fallback; confirm the chosen fallback and a single fallback event.

## Release gate

- [ ] Run unit tests for the Yell progress and Face gesture state machines.
- [ ] Build Android and iOS development builds successfully.
- [ ] Re-run the audio-isolation test on every supported OS/device combination after any native audio or alarm-service change.
- [ ] Do not claim the alarm sound cannot trigger Yell until that behavior passes on physical devices.

## Known platform constraint

The current iOS AlarmKit integration owns scheduled alarm playback and does not expose a runtime volume control to this challenge. To prevent the alarm tone from completing Yell by itself, scheduled iOS Yell alarms currently route immediately to the selected fallback. Supporting live Yell during an iOS AlarmKit ring requires an approved change to how that ring is played; it must not be bypassed by claiming that the current app-level audio player can mute AlarmKit.
