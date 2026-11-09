# Store privacy disclosures for Yell to Wake and Face Challenge

This text documents the intended disclosures for the store-console forms. It does not submit or change App Store Connect or Google Play Console answers; those consoles require an authorized account. Re-check the final release build and the enabled Mixpanel/RevenueCat SDK settings before submitting.

## App Store Connect

For Yell to Wake and Face Challenge:

- Microphone samples and camera frames are processed temporarily on the device while the relevant challenge is active.
- Wayykup does not save or transmit raw audio, video, camera frames, face measurements, face identity templates, or biometric identifiers.
- Face detection is for gestures only; it is not face recognition or identification.
- Challenge analytics may be transmitted to Mixpanel when its token is configured: challenge type, mode, duration, attempt count, fallback/permission outcome, and (for Face Challenge) the randomized gesture sequence. The event payload excludes raw media and face measurements.
- The app also sends other product-usage events and may use device/app diagnostics. Review the complete event map and Mixpanel's SDK collection settings when answering the app's overall **Data Linked to You** and **Data Used to Track You** questions; these two challenges do not add tracking or advertising use.

## Google Play Data safety

For these two challenges specifically:

- **Audio files / voice recordings:** not collected or shared by Wayykup; microphone input is used for on-device level calculation only.
- **Photos and videos:** not collected or shared by Wayykup for Face Challenge; camera frames are processed on-device and discarded.
- **Biometric information:** not collected or shared; no face recognition, identity template, or biometric identification is performed.
- **App activity:** disclose challenge metadata only if it is sent to Mixpanel (challenge type, mode, duration, attempts, fallback/permission outcome, and Face gesture sequence). Classify and mark collection, sharing, purpose, and deletion answers according to the final Mixpanel configuration and actual event map.
- **Device or other identifiers / diagnostics:** review the enabled Mixpanel and RevenueCat SDK settings and disclose any identifiers or diagnostics they transmit in the complete app Data safety form.
- Do not mark the raw microphone or camera payloads as collected by Wayykup unless the release implementation changes to save or transmit them.

## Before submission

1. Verify this policy matches the release build and all third-party SDK behavior.
2. Inspect Mixpanel event payloads to ensure challenge events contain no raw media, facial measurements, precise location, or other PII.
3. Check RevenueCat and Mixpanel disclosures independently; third-party SDK collection may affect the overall store answers.
4. Update the answers in both store consoles and retain the release-review evidence.
