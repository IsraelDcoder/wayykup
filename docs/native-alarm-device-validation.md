# Native alarm device validation

Status: **not run**. This environment has no attached test phones and the Android Gradle wrapper could not download Gradle because `services.gradle.org` was unreachable. Do not interpret this checklist as a passing report.

| State | Android | iOS |
|---|---|---|
| App open, screen on | Not run | Not run |
| Screen locked | Not run | Not run |
| App swiped away | Not run | Not run |
| Do Not Disturb / Focus on | Not run | Not run |
| Silent switch / minimum media volume | Not run | Not run |
| Low Power Mode / battery saver | Not run | Not run |
| Reboot after scheduling | Not run | Not run |
| Revoke and restore permissions | Not run | Not run |
| Bluetooth headphones connected | Not run | Not run |
| Unplugged overnight, repeated for three nights | Not run | Not run |

Required devices also remain outstanding: Pixel, Samsung, Xiaomi/Tecno/Infinix, iOS 26+, and iOS 25 fallback. No screen recordings or measured ring latencies are available.

For each device, run the 60-second test first, then the five-minute alarm in each applicable state. Record device model, OS version, scheduled timestamp, native `fired` and `ringStarted` timestamps, ring latency, permission state, and a screen recording. Do not certify a state unless the challenge is presented, audio remains active until completion, and stopping the system alarm re-arms the alarm.
