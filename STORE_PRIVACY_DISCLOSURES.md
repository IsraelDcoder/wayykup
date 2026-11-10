# Store privacy disclosures for wake-up challenges

This text documents the intended disclosures for the four supported challenges. It does not submit or change App Store Connect or Google Play Console answers; those consoles require an authorized account. Re-check the final release build and the enabled Mixpanel/RevenueCat SDK settings before submitting.

## App Store Connect

For Yell to Stop, Push-up Challenge, Shake Your Phone, and Object Hunt:

- Speech audio is processed on-device while Yell to Stop is active; it is not saved or uploaded.
- Camera images and pose landmarks are processed temporarily on-device for Push-up Challenge and Object Hunt; they are not saved or uploaded. Push-up pose detection is for repetition counting, not person identification.
- Shake challenge sensor measurements are processed in memory and are not saved or uploaded.
- Challenge analytics may be transmitted to Mixpanel when its token is configured, including the challenge type, selected phrase, completion duration, target object, attempts, or permission outcome. Analytics must not include raw audio, images, or pose landmarks.
- The app also sends other product-usage events and may use device/app diagnostics. Review the complete event map and Mixpanel's SDK collection settings when answering the app's overall **Data Linked to You** and **Data Used to Track You** questions; these two challenges do not add tracking or advertising use.

## Google Play Data safety

For these challenges specifically:

- **Audio files / voice recordings:** not collected or shared by Wayykup; speech audio is used for on-device phrase recognition only.
- **Photos and videos:** not collected or shared; images used for object and pose detection are processed on-device and discarded.
- **Biometric information:** not collected or shared; pose detection is not used to identify a person.
- **App activity:** disclose challenge metadata only if it is sent to Mixpanel (such as challenge type, phrase, duration, target, attempts, or permission outcome). Classify and mark collection, sharing, purpose, and deletion answers according to the final Mixpanel configuration and actual event map.
- **Device or other identifiers / diagnostics:** review the enabled Mixpanel and RevenueCat SDK settings and disclose any identifiers or diagnostics they transmit in the complete app Data safety form.
- Do not mark the raw microphone or camera payloads as collected by Wayykup unless the release implementation changes to save or transmit them.

## Before submission

1. Verify this policy matches the release build and all third-party SDK behavior.
2. Inspect Mixpanel event payloads to ensure challenge events contain no raw media, facial measurements, precise location, or other PII.
3. Check RevenueCat and Mixpanel disclosures independently; third-party SDK collection may affect the overall store answers.
4. Update the answers in both store consoles and retain the release-review evidence.
