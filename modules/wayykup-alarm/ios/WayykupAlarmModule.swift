import ExpoModulesCore
import ActivityKit
import Foundation
import SQLite3
import UIKit
import UserNotifications
import Vision
import AVFoundation
import ImageIO
import Speech

#if canImport(AlarmKit)
import AlarmKit
import AppIntents
import SwiftUI
#endif

private func removeCachedCameraImage(at url: URL) {
  let fileManager = FileManager.default
  let cacheRoots = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)
    .map { $0.standardizedFileURL.path } + [fileManager.temporaryDirectory.standardizedFileURL.path]
  let path = url.standardizedFileURL.path
  guard cacheRoots.contains(where: { path.hasPrefix($0 + "/") }) else { return }
  do {
    try fileManager.removeItem(at: url)
  } catch {
    NSLog("WayykupAlarm could not remove temporary camera image: %@", error.localizedDescription)
  }
}

public final class WayykupAlarmModule: Module {
  private lazy var speechPhraseRecognizer = SpeechPhraseRecognizer { [weak self] result in
    self?.sendEvent("speechResult", result)
  } onError: { [weak self] reason in
    self?.sendEvent("speechError", ["reason": reason])
  }

  public func definition() -> ModuleDefinition {
    Name("WayykupAlarm")
    Events("ringStarted", "challengeCompleted", "healthChanged", "speechResult", "speechError")

    AsyncFunction("schedule") { (alarm: [String: Any]) async throws in
      try await NativeAlarmScheduler.schedule(alarm)
    }

    AsyncFunction("detectPushUpPose") { (uri: String) throws -> [String: Any] in
      guard let url = URL(string: uri), url.isFileURL else {
        throw NativeAlarmError.invalidAlarm("Wayykup could not access the captured push-up image.")
      }
      defer { removeCachedCameraImage(at: url) }
      let request = VNDetectHumanBodyPoseRequest()
      try VNImageRequestHandler(url: url, options: [:]).perform([request])
      guard let observation = request.results?.first else { return [:] }
      let recognizedPoints = try observation.recognizedPoints(.all)
      let joints: [(String, VNHumanBodyPoseObservation.JointName)] = [
        ("leftShoulder", .leftShoulder),
        ("leftElbow", .leftElbow),
        ("leftWrist", .leftWrist),
        ("leftHip", .leftHip),
        ("leftAnkle", .leftAnkle),
        ("rightShoulder", .rightShoulder),
        ("rightElbow", .rightElbow),
        ("rightWrist", .rightWrist),
        ("rightHip", .rightHip),
        ("rightAnkle", .rightAnkle),
      ]
      var pose: [String: Any] = [:]
      for (name, joint) in joints {
        guard let point = recognizedPoints[joint] else { continue }
        pose[name] = [
          "x": Double(point.location.x),
          "y": Double(1 - point.location.y),
          "confidence": Double(point.confidence),
        ]
      }
      return pose
    }

    AsyncFunction("classifyImage") { (uri: String, target: String) throws -> [[String: Any]] in
      guard let url = URL(string: uri), url.isFileURL else {
        throw NativeAlarmError.invalidAlarm("Wayykup could not access the captured object photo.")
      }
      defer { removeCachedCameraImage(at: url) }
      guard !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NativeAlarmError.invalidAlarm("Wayykup could not decode the captured object photo or target.")
      }
      var confidences: [String: Float] = [:]
      func classify(_ image: CGImage) throws {
        let request = VNClassifyImageRequest()
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        for result in request.results ?? [] {
          confidences[result.identifier] = max(confidences[result.identifier] ?? 0, result.confidence)
        }
      }

      try classify(image)
      let centerCrop = CGRect(
        x: CGFloat(image.width) * 0.2,
        y: CGFloat(image.height) * 0.2,
        width: CGFloat(image.width) * 0.6,
        height: CGFloat(image.height) * 0.6
      )
      if let crop = image.cropping(to: centerCrop) {
        try classify(crop)
      }

      let saliencyRequest = VNGenerateObjectnessBasedSaliencyImageRequest()
      try VNImageRequestHandler(cgImage: image, options: [:]).perform([saliencyRequest])
      let imageBounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
      let salientObjects = saliencyRequest.results?.first?.salientObjects ?? []
      for object in salientObjects.sorted(by: { $0.confidence > $1.confidence }).prefix(6) {
        let box = object.boundingBox
        let paddingX = box.width * 0.12
        let paddingY = box.height * 0.12
        let normalizedBox = CGRect(
          x: max(0, box.minX - paddingX),
          y: max(0, box.minY - paddingY),
          width: min(1, box.width + paddingX * 2),
          height: min(1, box.height + paddingY * 2)
        ).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        let cropRect = CGRect(
          x: normalizedBox.minX * CGFloat(image.width),
          y: (1 - normalizedBox.maxY) * CGFloat(image.height),
          width: normalizedBox.width * CGFloat(image.width),
          height: normalizedBox.height * CGFloat(image.height)
        ).integral.intersection(imageBounds)
        guard cropRect.width >= 24, cropRect.height >= 24,
              let crop = image.cropping(to: cropRect) else { continue }
        try classify(crop)
      }

      NSLog("Wayykup object recognition target=%@ regions=%d", target, salientObjects.count + 2)
      return confidences
        .sorted { $0.value > $1.value }
        .prefix(48)
        .map { ["label": $0.key, "confidence": Double($0.value)] }
    }

    AsyncFunction("cancel") { (alarmId: String) async throws in
      try await NativeAlarmScheduler.cancel(alarmId: alarmId, removeDefinition: true)
    }

    AsyncFunction("rearm") { (alarmId: String, delaySeconds: Double) async throws in
      try await NativeAlarmScheduler.rearm(alarmId: alarmId, delaySeconds: delaySeconds)
    }

    AsyncFunction("activateChallenge") { (alarmId: String, occurrenceId: String) throws in
      try NativeAlarmScheduler.activateChallenge(alarmId: alarmId, occurrenceId: occurrenceId)
    }

    AsyncFunction("cancelChain") { (alarmId: String, status: String, occurrenceId: String) async throws in
      let ring = NativeAlarmScheduler.pendingRing
      try await NativeAlarmScheduler.cancelChain(
        alarmId: alarmId,
        status: status,
        occurrenceId: occurrenceId
      )
      self.sendEvent("challengeCompleted", [
        "alarmId": alarmId,
        "occurrenceId": ring?["occurrenceId"] as? String ?? occurrenceId
      ])
    }

    AsyncFunction("getHealth") {
      await NativeAlarmScheduler.health()
    }

    AsyncFunction("requestPermissions") {
      try await NativeAlarmScheduler.requestPermissions()
      return await NativeAlarmScheduler.health()
    }

    AsyncFunction("openSettings") { (kind: String) in
      await NativeAlarmScheduler.openSettings(kind: kind)
    }

    AsyncFunction("getPendingChallenge") {
      NativeAlarmScheduler.pendingRing
    }

    AsyncFunction("consumePendingChallenge") {
      NativeAlarmScheduler.clearPendingRing()
    }

    AsyncFunction("startTestAlarm") { () async throws in
      try await NativeAlarmScheduler.scheduleTest()
    }

    AsyncFunction("startSpeechRecognition") { (phrase: String) async throws in
      try await self.speechPhraseRecognizer.start(phrase: phrase)
    }

    AsyncFunction("stopSpeechRecognition") {
      self.speechPhraseRecognizer.stop()
    }

    AsyncFunction("setAlarmAudioDucked") { (_: Bool, _: Double) throws in
      throw NSError(domain: "WayykupAlarmAudio", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "iOS AlarmKit does not expose runtime alarm volume control."
      ])
    }

    OnDestroy {
      self.speechPhraseRecognizer.stop()
    }
  }
}

private final class SpeechPhraseRecognizer {
  private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private let engine = AVAudioEngine()
  private let emitResult: ([String: Any]) -> Void
  private let emitError: (String) -> Void
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var expectedPhrase = ""
  private var recognitionActive = false
  private var tapInstalled = false

  init(
    onResult: @escaping ([String: Any]) -> Void,
    onError: @escaping (String) -> Void
  ) {
    emitResult = onResult
    emitError = onError
  }

  func start(phrase: String) async throws {
    guard let recognizer, recognizer.isAvailable else {
      throw NativeAlarmError.invalidAlarm("English speech recognition is unavailable on this device.")
    }
    guard recognizer.supportsOnDeviceRecognition else {
      throw NativeAlarmError.invalidAlarm("On-device English speech recognition is unavailable. Download the English speech model in Settings and try again.")
    }
    let authorization = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard authorization == .authorized else {
      throw NativeAlarmError.invalidAlarm("Allow speech recognition in Settings to use Yell to Stop.")
    }

    stop()
    expectedPhrase = Self.normalized(phrase)
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .mixWithOthers, .allowBluetooth])
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
    recognitionRequest.shouldReportPartialResults = true
    recognitionRequest.requiresOnDeviceRecognition = true
    request = recognitionRequest
    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
      recognitionRequest.append(buffer)
    }
    tapInstalled = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      stop()
      throw error
    }
    recognitionActive = true
    task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
      guard let self else { return }
      guard self.recognitionActive else { return }
      if let result {
        let text = result.bestTranscription.formattedString
        let segments = result.bestTranscription.segments
        let confidence = segments.isEmpty
          ? 0
          : Double(segments.reduce(Float.zero) { $0 + $1.confidence } / Float(segments.count))
        let recognized = confidence >= 0.35
          && Self.normalized(text) == self.expectedPhrase
        if result.isFinal || recognized {
          self.emitResult(["recognized": recognized, "text": text, "confidence": confidence])
          self.stop()
        }
      }
      if let error {
        self.emitError(error.localizedDescription)
        self.stop()
      }
    }
  }

  func stop() {
    recognitionActive = false
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    if engine.isRunning { engine.stop() }
    request?.endAudio()
    task?.cancel()
    request = nil
    task = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private static func normalized(_ value: String) -> String {
    value.lowercased()
      .replacingOccurrences(of: "i'm", with: "im")
      .replacingOccurrences(of: "i am", with: "im")
      .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
      .joined(separator: " ")
  }
}

private enum NativeAlarmScheduler {
  private static let prefs = UserDefaults.standard
  private static let alarmsKey = "wayykup_native_alarms"
  private static let pendingKey = "wayykup_pending_ring"
  private static let testPassedKey = "wayykup_test_alarm_passed"
  private static let testAlarmId = "__wayykup_test_alarm__"
  private static let supportedTasks: Set<String> = [
    "Yell to Stop",
    "Push-up Challenge",
    "Shake Your Phone",
    "Object Hunt",
  ]

  static var pendingRing: [String: Any]? {
    prefs.dictionary(forKey: pendingKey)
  }

  static func clearPendingRing() {
    prefs.removeObject(forKey: pendingKey)
  }

  static func schedule(_ alarm: [String: Any]) async throws {
    guard let alarmId = alarm["id"] as? String else {
      throw NativeAlarmError.invalidAlarm("Alarm id is required.")
    }
    guard let task = alarm["task"] as? String, supportedTasks.contains(task) else {
      throw NativeAlarmError.invalidAlarm("Choose one of the four supported wake-up challenges before scheduling this alarm.")
    }
    let currentHealth = await health()
    guard currentHealth["canSchedule"] as? Bool == true else {
      throw NativeAlarmError.permissionDenied
    }
    if let pendingRing,
       pendingRing["alarmId"] as? String == alarmId,
       ["ringing", "challenge_pending", "challenge_active"].contains(pendingRing["state"] as? String ?? "") {
      prefs.set(alarm, forKey: "\(alarmsKey).\(alarmId)")
      NSLog("WayykupAlarm event=schedule_skipped reason=occurrence_active alarmId=%@", alarmId)
      return
    }
    guard alarm["enabled"] as? Bool != false else {
      try await cancel(alarmId: alarmId, removeDefinition: true)
      return
    }
    let date = try nextDate(for: alarm, after: Date())
    try await cancelScheduledAlarm(alarmId: alarmId)
    prefs.set(alarm, forKey: "\(alarmsKey).\(alarmId)")
    NSLog(
      "WayykupAlarm event=scheduled alarmId=%@ scheduledAt=%.0f device=%@ os=%@",
      alarmId,
      date.timeIntervalSince1970 * 1000,
      deviceModel,
      ProcessInfo.processInfo.operatingSystemVersionString
    )
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      NSLog("WayykupAlarm event=schedule_engine engine=AlarmKit alarmId=%@", alarmId)
      try await scheduleAlarmKit(alarm, alarmId: alarmId, date: date)
      return
    }
    NSLog("WayykupAlarm event=schedule_engine engine=notification_fallback reason=ios_below_26 alarmId=%@", alarmId)
    #else
    NSLog("WayykupAlarm event=schedule_engine engine=notification_fallback reason=AlarmKit_framework_unavailable alarmId=%@", alarmId)
    #endif
    try await scheduleNotificationFallback(alarm, alarmId: alarmId, date: date)
  }

  static func cancel(alarmId: String, removeDefinition: Bool) async throws {
    try await cancelScheduledAlarm(alarmId: alarmId)
    if removeDefinition {
      prefs.removeObject(forKey: "\(alarmsKey).\(alarmId)")
    }
  }

  private static func cancelScheduledAlarm(alarmId: String) async throws {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      var ids = prefs.array(forKey: chainKey(alarmId)) as? [String] ?? []
      if let alarmIdValue = prefs.string(forKey: alarmKitIdKey(alarmId)) {
        ids.append(alarmIdValue)
      }
      for value in ids {
        guard let id = UUID(uuidString: value) else { continue }
        try AlarmManager.shared.cancel(id: id)
      }
    }
    #endif
    let center = UNUserNotificationCenter.current()
    let identifiers = Set(
      (prefs.stringArray(forKey: notificationIdsKey(alarmId)) ?? [])
        + notificationIds(alarmId)
    )
    center.removePendingNotificationRequests(withIdentifiers: Array(identifiers))
    center.removeDeliveredNotifications(withIdentifiers: Array(identifiers))
    prefs.removeObject(forKey: notificationIdsKey(alarmId))
    prefs.removeObject(forKey: chainKey(alarmId))
    prefs.removeObject(forKey: alarmKitIdKey(alarmId))
    prefs.removeObject(forKey: "wayykup_chain_started_\(alarmId)")
  }

  static func rearm(alarmId: String, delaySeconds: Double = 75) async throws {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      try await scheduleAlarmKitRearm(alarmId: alarmId, delaySeconds: delaySeconds)
      return
    }
    #endif
    try await scheduleNotificationRearm(alarmId: alarmId, delaySeconds: delaySeconds)
  }

  static func activateChallenge(alarmId: String, occurrenceId: String) throws {
    var ring = pendingRing
    if ring?["alarmId"] as? String != alarmId || ring?["occurrenceId"] as? String != occurrenceId {
      guard let alarm = prefs.dictionary(forKey: "\(alarmsKey).\(alarmId)") else {
        throw NativeAlarmError.invalidAlarm("The active alarm occurrence could not be restored.")
      }
      let now = Date().timeIntervalSince1970 * 1000
      ring = [
        "alarmId": alarmId,
        "occurrenceId": occurrenceId,
        "at": now,
        "scheduledAt": now,
        "timeZone": TimeZone.current.identifier,
        "challenge": alarm["task"] as? String ?? "Shake Your Phone",
        "sound": alarm["sound"] as? String ?? "police_siren",
        "testAlarm": alarmId == testAlarmId,
        "state": "ringing"
      ]
    }
    guard var activeRing = ring else {
      throw NativeAlarmError.invalidAlarm("The active alarm occurrence is unavailable.")
    }
    let state = activeRing["state"] as? String ?? "ringing"
    if state == "challenge_active" { return }
    guard state == "ringing" || state == "challenge_pending" else {
      throw NativeAlarmError.invalidAlarm("This alarm occurrence cannot start its challenge from state \(state).")
    }
    activeRing["state"] = "challenge_pending"
    prefs.set(activeRing, forKey: pendingKey)
    activeRing["state"] = "challenge_active"
    prefs.set(activeRing, forKey: pendingKey)
  }

  static func cancelChain(alarmId: String, status: String, occurrenceId: String) async throws {
    guard status == "completed" else {
      throw NativeAlarmError.invalidAlarm("Only a successfully completed challenge can dismiss an alarm.")
    }
    guard var ring = pendingRing,
          ring["alarmId"] as? String == alarmId,
          ring["occurrenceId"] as? String == occurrenceId else {
      if (prefs.stringArray(forKey: "wayykup_dismissed_occurrences") ?? []).contains(occurrenceId) { return }
      throw NativeAlarmError.invalidAlarm("The active alarm occurrence does not match the completed challenge.")
    }
    let state = ring["state"] as? String ?? "ringing"
    guard state == "challenge_active" || state == "challenge_completed" || state == "dismissed" else {
      throw NativeAlarmError.invalidAlarm("The challenge must be active before it can be completed.")
    }
    if state == "dismissed" { return }
    ring["state"] = "challenge_completed"
    prefs.set(ring, forKey: pendingKey)
    try await cancelScheduledAlarm(alarmId: alarmId)
    let isTestAlarm = ring["testAlarm"] as? Bool == true || alarmId.hasPrefix(testAlarmId)
    if status == "completed", isTestAlarm {
      prefs.set(true, forKey: testPassedKey)
    }
    NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: status)
    ring["state"] = "dismissed"
    prefs.set(ring, forKey: pendingKey)
    var dismissed = Set(prefs.stringArray(forKey: "wayykup_dismissed_occurrences") ?? [])
    dismissed.insert(occurrenceId)
    prefs.set(Array(dismissed), forKey: "wayykup_dismissed_occurrences")
    NSLog(
      "WayykupAlarm event=challengeCompleted alarmId=%@ status=%@ at=%.0f device=%@",
      alarmId,
      status,
      Date().timeIntervalSince1970 * 1000,
      deviceModel
    )
    clearPendingRing()
  }

  static func health() async -> [String: Any] {
    let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
    let notificationAllowed = notificationSettings.authorizationStatus == .authorized
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let authorized = AlarmManager.shared.authorizationState == .authorized
      return [
        "authorized": authorized,
        "exactAlarm": authorized,
        "fullScreenIntent": authorized,
        "notifications": notificationAllowed,
        "batteryRestricted": false,
        "canSchedule": authorized,
        "canRingNow": authorized,
        "platform": "ios",
        "deviceModel": deviceModel,
        "osVersion": "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
        "reliability": "native",
        "testAlarmPassed": prefs.bool(forKey: testPassedKey)
      ]
    }
    #endif
    return [
      "authorized": notificationAllowed,
      "exactAlarm": true,
      "fullScreenIntent": false,
      "notifications": notificationAllowed,
      "batteryRestricted": false,
      "canSchedule": notificationAllowed,
      "canRingNow": notificationAllowed,
      "platform": "ios",
      "deviceModel": deviceModel,
      "osVersion": "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
      "reliability": "reduced",
      "testAlarmPassed": prefs.bool(forKey: testPassedKey)
    ]
  }

  static func requestPermissions() async throws {
    _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      _ = try await AlarmManager.shared.requestAuthorization()
    }
    #endif
  }

  static func openSettings(kind: String) async {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    await MainActor.run {
      UIApplication.shared.open(url)
    }
  }

  static func scheduleTest() async throws {
    let currentHealth = await health()
    guard currentHealth["canSchedule"] as? Bool == true else {
      throw NativeAlarmError.permissionDenied
    }
    prefs.set(false, forKey: testPassedKey)
    let date = Date().addingTimeInterval(60)
    let calendar = Calendar.current
    let alarm: [String: Any] = [
      "id": testAlarmId,
      "time": String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date)),
      "days": [String](),
      "enabled": true,
      "task": "Shake Your Phone",
      "sound": "police_siren",
      "testAlarm": true
    ]
    try await cancelScheduledAlarm(alarmId: testAlarmId)
    prefs.set(alarm, forKey: "\(alarmsKey).\(testAlarmId)")
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      try await scheduleAlarmKit(alarm, alarmId: testAlarmId, date: date)
      return
    }
    #endif
    try await scheduleNotificationFallback(alarm, alarmId: testAlarmId, date: date)
  }

  private static var deviceModel: String {
    UIDevice.current.model
  }

  private static func nextDate(for alarm: [String: Any], after: Date) throws -> Date {
    let components = (alarm["time"] as? String ?? "").split(separator: ":")
    guard components.count == 2, let hour = Int(components[0]), let minute = Int(components[1]),
          (0...23).contains(hour), (0...59).contains(minute) else {
      throw NativeAlarmError.invalidAlarm("Alarm time must be in HH:mm format.")
    }
    let days = alarm["days"] as? [String] ?? []
    let calendar = Calendar.current
    for offset in 0...7 {
      guard let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: after)),
            let candidate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
            candidate > after else { continue }
      if days.isEmpty {
        if offset == 0 || offset == 1 { return candidate }
        break
      }
      let mondayIndex = (calendar.component(.weekday, from: candidate) + 5) % 7
      if days.contains(String(mondayIndex)) { return candidate }
    }
    throw NativeAlarmError.invalidAlarm("No upcoming alarm occurrence was found.")
  }

  private static func notificationIds(_ alarmId: String) -> [String] {
    ["wayykup.\(alarmId).base"] + chainNotificationIds(alarmId)
  }

  private static func notificationIdsKey(_ alarmId: String) -> String {
    "wayykup_notification_ids_\(alarmId)"
  }

  private static func chainNotificationIds(_ alarmId: String) -> [String] {
    (0..<24).map { "wayykup.\(alarmId).rearm.\($0)" }
  }

  private static func chainKey(_ alarmId: String) -> String { "wayykup_chain_\(alarmId)" }
  private static func alarmKitIdKey(_ alarmId: String) -> String { "wayykup_alarmkit_\(alarmId)" }

  private static func scheduleNotificationFallback(_ alarm: [String: Any], alarmId: String, date: Date) async throws {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests()
    let related = Set(notificationIds(alarmId))
    let storedIdentifiers = Set(prefs.stringArray(forKey: notificationIdsKey(alarmId)) ?? [])
    let available = pending.filter { !related.contains($0.identifier) && !storedIdentifiers.contains($0.identifier) }.count
    let availableSlots = 64 - available
    guard availableSlots > 0 else {
      throw NativeAlarmError.tooManyNotifications
    }
    let allAlarmValues = prefs.dictionaryRepresentation()
      .filter { $0.key.hasPrefix("\(alarmsKey).") }
      .map { $0.value }
    let enabledAlarmCount = max(1, allAlarmValues.reduce(into: 0) { count, value in
      if ((value as? [String: Any])?["enabled"] as? Bool) != false { count += 1 }
    })
    let occurrenceLimit = min(7, max(1, availableSlots / enabledAlarmCount))
    let days = alarm["days"] as? [String] ?? []
    let occurrenceCount = days.isEmpty ? 1 : occurrenceLimit
    var occurrenceDate = date
    var requestIds: [String] = []
    do {
      for index in 0..<occurrenceCount {
        if index > 0 {
          occurrenceDate = try nextDate(for: alarm, after: occurrenceDate)
        }
        let occurrenceId = occurrenceIdentifier(alarmId: alarmId, date: occurrenceDate)
        let scheduledAt = occurrenceDate.timeIntervalSince1970 * 1000
        let identifier = "wayykup.\(alarmId).\(occurrenceId.replacingOccurrences(of: ":", with: "."))"
        let content = notificationContent(alarm: alarm, occurrenceId: occurrenceId, scheduledAt: scheduledAt)
        try await center.add(
          UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(
              timeInterval: max(1, occurrenceDate.timeIntervalSinceNow),
              repeats: false
            )
          )
        )
        requestIds.append(identifier)
      }
      prefs.set(requestIds, forKey: notificationIdsKey(alarmId))
      prefs.removeObject(forKey: chainKey(alarmId))
      NSLog("WayykupAlarm event=notification_fallback_scheduled alarmId=%@ occurrences=%d", alarmId, requestIds.count)
    } catch {
      center.removePendingNotificationRequests(withIdentifiers: requestIds)
      throw error
    }
  }

  private static func scheduleNotificationRearm(alarmId: String, delaySeconds: Double) async throws {
    guard let alarm = prefs.dictionary(forKey: "\(alarmsKey).\(alarmId)") else { return }
    let now = Date()
    let chainStartedKey = "wayykup_chain_started_\(alarmId)"
    let chainStartedAt = prefs.double(forKey: chainStartedKey)
    if chainStartedAt == 0 {
      prefs.set(now.timeIntervalSince1970, forKey: chainStartedKey)
    } else if now.timeIntervalSince1970 - chainStartedAt >= 30 * 60 {
      if let occurrenceId = pendingRing?["occurrenceId"] as? String {
        NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: "bypassed")
      }
      return
    }
    let idsKey = notificationIdsKey(alarmId)
    var ids = prefs.stringArray(forKey: idsKey) ?? []
    let rearmIds = ids.filter { $0.contains(".rearm.") }
    guard rearmIds.count < 24 else {
      if let occurrenceId = pendingRing?["occurrenceId"] as? String {
        NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: "bypassed")
      }
      return
    }

    let occurrenceId = pendingRing?["occurrenceId"] as? String
      ?? occurrenceIdentifier(alarmId: alarmId, date: now)
    let scheduledAt = pendingRing?["scheduledAt"] as? Double ?? now.timeIntervalSince1970 * 1000
    let content = notificationContent(alarm: alarm, occurrenceId: occurrenceId, scheduledAt: scheduledAt)
    content.title = "WAYYKUP · ALARM CONTINUES"
    content.body = "Your wake-up challenge is still waiting. Prove you are awake."
    let identifier = "wayykup.\(alarmId).rearm.\(rearmIds.count)"
    try await UNUserNotificationCenter.current().add(
      UNNotificationRequest(
        identifier: identifier,
        content: content,
        trigger: UNTimeIntervalNotificationTrigger(
          timeInterval: max(1, delaySeconds),
          repeats: false
        )
      )
    )
    ids.append(identifier)
    prefs.set(ids, forKey: idsKey)
  }

  private static func notificationContent(alarm: [String: Any], occurrenceId: String, scheduledAt: TimeInterval) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "WAYYKUP · TIME TO GET UP"
    content.body = "\(alarm["task"] as? String ?? "Wake-up") challenge. Prove you are awake."
    let selectedSound = alarm["sound"] as? String ?? "police_siren"
    content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: soundResource(for: selectedSound)))
    content.interruptionLevel = .timeSensitive
    content.userInfo = [
      "alarmId": alarm["id"] as? String ?? "",
      "occurrenceId": occurrenceId,
      "scheduledAt": scheduledAt,
      "timeZone": TimeZone.current.identifier,
      "challenge": alarm["task"] as? String ?? "Shake Your Phone",
      "sound": selectedSound
    ]
    return content
  }

  private static func occurrenceIdentifier(alarmId: String, date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar.current
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyy-MM-dd"
    return "\(alarmId):\(formatter.string(from: date))"
  }

  #if canImport(AlarmKit)
  @available(iOS 26.0, *)
  private static func scheduleAlarmKit(_ alarm: [String: Any], alarmId: String, date: Date) async throws {
    guard AlarmManager.shared.authorizationState == .authorized else {
      throw NativeAlarmError.permissionDenied
    }
    let id = UUID()
    let metadata = WayykupAlarmMetadata(
      alarmId: alarmId,
      occurrenceId: occurrenceIdentifier(alarmId: alarmId, date: date),
      challenge: alarm["task"] as? String ?? "Shake Your Phone",
      sound: alarm["sound"] as? String ?? "police_siren",
      scheduledAt: date.timeIntervalSince1970 * 1000,
      timeZone: TimeZone.current.identifier
    )
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource("WAYYKUP · TIME TO GET UP"),
      stopButton: AlarmButton(text: LocalizedStringResource("Snooze"), textColor: .white, systemImageName: "stop.fill"),
      secondaryButton: AlarmButton(text: LocalizedStringResource("Prove it"), textColor: .white, systemImageName: "arrow.up.forward.app"),
      secondaryButtonBehavior: .custom
    )
    let attributes = AlarmAttributes(
      presentation: AlarmPresentation(alert: alert),
      metadata: metadata,
      tintColor: Color.orange
    )
    let configuration = AlarmManager.AlarmConfiguration<WayykupAlarmMetadata>(
      schedule: .fixed(date),
      attributes: attributes,
      stopIntent: RearmAlarmIntent(
        alarmId: alarmId,
        occurrenceId: metadata.occurrenceId,
        challenge: metadata.challenge,
        sound: metadata.sound,
        scheduledAt: metadata.scheduledAt,
        timeZone: metadata.timeZone
      ),
      secondaryIntent: OpenChallengeIntent(
        alarmId: alarmId,
        occurrenceId: metadata.occurrenceId,
        challenge: metadata.challenge,
        sound: metadata.sound,
        scheduledAt: metadata.scheduledAt,
        timeZone: metadata.timeZone
      ),
      sound: AlertConfiguration.AlertSound.named(soundResource(for: metadata.sound))
    )
    try await AlarmManager.shared.schedule(id: id, configuration: configuration)
    prefs.set(id.uuidString, forKey: alarmKitIdKey(alarmId))
  }

  @available(iOS 26.0, *)
  private static func scheduleAlarmKitRearm(alarmId: String, delaySeconds: Double) async throws {
    let key = chainKey(alarmId)
    var ids = prefs.array(forKey: key) as? [String] ?? []
    let startedAt = prefs.double(forKey: "wayykup_chain_started_\(alarmId)")
    let now = Date()
    if startedAt == 0 {
      prefs.set(now.timeIntervalSince1970, forKey: "wayykup_chain_started_\(alarmId)")
    } else if now.timeIntervalSince1970 - startedAt >= 30 * 60 || ids.count >= 24 {
      if let occurrenceId = pendingRing?["occurrenceId"] as? String {
        NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: "bypassed")
      }
      return
    }
    guard let alarm = prefs.dictionary(forKey: "\(alarmsKey).\(alarmId)") else { return }
    if let occurrenceId = pendingRing?["occurrenceId"] as? String {
      NativeOccurrenceStore.updateRearms(occurrenceId: occurrenceId, count: ids.count + 1)
    }
    let date = now.addingTimeInterval(delaySeconds)
    let id = UUID()
    let occurrenceId = pendingRing?["occurrenceId"] as? String ?? occurrenceIdentifier(alarmId: alarmId, date: now)
    let metadata = WayykupAlarmMetadata(
      alarmId: alarmId,
      occurrenceId: occurrenceId,
      challenge: alarm["task"] as? String ?? "Shake Your Phone",
      sound: alarm["sound"] as? String ?? "police_siren",
      scheduledAt: now.timeIntervalSince1970 * 1000,
      timeZone: pendingRing?["timeZone"] as? String ?? TimeZone.current.identifier
    )
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource("WAYYKUP · ALARM CONTINUES"),
      stopButton: AlarmButton(text: LocalizedStringResource("Snooze"), textColor: .white, systemImageName: "stop.fill"),
      secondaryButton: AlarmButton(text: LocalizedStringResource("Prove it"), textColor: .white, systemImageName: "arrow.up.forward.app"),
      secondaryButtonBehavior: .custom
    )
    let attributes = AlarmAttributes(
      presentation: AlarmPresentation(alert: alert),
      metadata: metadata,
      tintColor: Color.orange
    )
    let configuration = AlarmManager.AlarmConfiguration<WayykupAlarmMetadata>(
      schedule: .fixed(date),
      attributes: attributes,
      stopIntent: RearmAlarmIntent(
        alarmId: alarmId,
        occurrenceId: occurrenceId,
        challenge: metadata.challenge,
        sound: metadata.sound,
        scheduledAt: metadata.scheduledAt,
        timeZone: metadata.timeZone
      ),
      secondaryIntent: OpenChallengeIntent(
        alarmId: alarmId,
        occurrenceId: occurrenceId,
        challenge: metadata.challenge,
        sound: metadata.sound,
        scheduledAt: metadata.scheduledAt,
        timeZone: metadata.timeZone
      ),
      sound: AlertConfiguration.AlertSound.named(soundResource(for: metadata.sound))
    )
    try await AlarmManager.shared.schedule(id: id, configuration: configuration)
    ids.append(id.uuidString)
    prefs.set(ids, forKey: key)
  }

  @available(iOS 26.0, *)
  fileprivate static func storeRing(
    alarmId: String,
    occurrenceId: String,
    challenge: String,
    sound: String,
    scheduledAt: Double,
    timeZone: String,
    isRearm: Bool
  ) {
    let at = Date().timeIntervalSince1970 * 1000
    let previous = pendingRing
    let sameOccurrence = previous?["alarmId"] as? String == alarmId
      && previous?["occurrenceId"] as? String == occurrenceId
    let state = sameOccurrence && !isRearm ? previous?["state"] as? String ?? "ringing" : "ringing"
    let ring: [String: Any] = [
      "alarmId": alarmId,
      "occurrenceId": occurrenceId,
      "at": at,
      "scheduledAt": scheduledAt,
      "timeZone": timeZone,
      "challenge": challenge,
      "sound": sound,
      "testAlarm": alarmId == testAlarmId,
      "state": state
    ]
    prefs.set(ring, forKey: pendingKey)
    NSLog(
      "WayykupAlarm event=ringStarted alarmId=%@ occurrenceId=%@ scheduledAt=%.0f at=%.0f device=%@",
      alarmId,
      occurrenceId,
      scheduledAt,
      at,
      deviceModel
    )
    NativeOccurrenceStore.markRinging(
      alarmId: alarmId,
      occurrenceId: occurrenceId,
      challenge: challenge,
      sound: sound,
      scheduledAt: scheduledAt,
      firstRingAt: at,
      timeZone: timeZone
    )
  }

  #endif
}

private func soundResource(for sound: String) -> String {
  let names: Set<String> = [
    "police_siren",
    "air_raid",
    "fire_alarm",
    "industrial_klaxon",
    "accelerating_beeps",
    "metal_clang",
    "bass_earthquake",
    "screech",
    "emergency_two_tone",
    "chaos_final_boss"
  ]
  return "\(names.contains(sound) ? sound : "police_siren").caf"
}

private enum NativeAlarmError: LocalizedError {
  case invalidAlarm(String)
  case permissionDenied
  case tooManyNotifications

  var errorDescription: String? {
    switch self {
    case .invalidAlarm(let message): message
    case .permissionDenied: "Allow AlarmKit access before scheduling an alarm."
    case .tooManyNotifications: "iOS notification fallback has reached the 64-request limit. Disable another alarm or upgrade to iOS 26 AlarmKit."
    }
  }
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
private struct RearmAlarmIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Re-arm Wayykup"
  static var isDiscoverable = false
  @Parameter(title: "Alarm") var alarmId: String
  @Parameter(title: "Occurrence") var occurrenceId: String
  @Parameter(title: "Challenge") var challenge: String
  @Parameter(title: "Sound") var sound: String
  @Parameter(title: "Scheduled at") var scheduledAt: Double
  @Parameter(title: "Time zone") var timeZone: String

  init() {}

  init(alarmId: String, occurrenceId: String, challenge: String, sound: String, scheduledAt: Double, timeZone: String) {
    self.alarmId = alarmId
    self.occurrenceId = occurrenceId
    self.challenge = challenge
    self.sound = sound
    self.scheduledAt = scheduledAt
    self.timeZone = timeZone
  }

  func perform() async throws -> some IntentResult {
    NativeAlarmScheduler.storeRing(
      alarmId: alarmId,
      occurrenceId: occurrenceId,
      challenge: challenge,
      sound: sound,
      scheduledAt: scheduledAt,
      timeZone: timeZone,
      isRearm: true
    )
    try await NativeAlarmScheduler.rearm(alarmId: alarmId)
    return .result()
  }
}

@available(iOS 26.0, *)
private struct OpenChallengeIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Prove it"
  static var isDiscoverable = false
  static var openAppWhenRun = true
  @Parameter(title: "Alarm") var alarmId: String
  @Parameter(title: "Occurrence") var occurrenceId: String
  @Parameter(title: "Challenge") var challenge: String
  @Parameter(title: "Sound") var sound: String
  @Parameter(title: "Scheduled at") var scheduledAt: Double
  @Parameter(title: "Time zone") var timeZone: String

  init() {}

  init(alarmId: String, occurrenceId: String, challenge: String, sound: String, scheduledAt: Double, timeZone: String) {
    self.alarmId = alarmId
    self.occurrenceId = occurrenceId
    self.challenge = challenge
    self.sound = sound
    self.scheduledAt = scheduledAt
    self.timeZone = timeZone
  }

  func perform() async throws -> some IntentResult {
    NativeAlarmScheduler.storeRing(
      alarmId: alarmId,
      occurrenceId: occurrenceId,
      challenge: challenge,
      sound: sound,
      scheduledAt: scheduledAt,
      timeZone: timeZone,
      isRearm: false
    )
    return .result()
  }
}
#endif

private enum NativeOccurrenceStore {
  static func markRinging(
    alarmId: String,
    occurrenceId: String,
    challenge: String,
    sound: String,
    scheduledAt: Double,
    firstRingAt: Double,
    timeZone: String
  ) {
    let db = openDatabase()
    defer { sqlite3_close(db) }
    let date = occurrenceId.split(separator: ":").last.map(String.init) ?? ""
    execute(db, """
      INSERT OR IGNORE INTO occurrences
        (id, alarmId, localDate, tz, scheduledAt, status, challenge, difficulty, tierReached, failedAttempts, rearms, soundId)
        VALUES (?, ?, ?, ?, ?, 'scheduled', ?, 1, 'gentle', 0, 0, ?)
      """, [
      occurrenceId,
      alarmId,
      date,
      timeZone,
      String(Int64(scheduledAt)),
      normalizedChallenge(challenge),
      normalizedSound(sound)
    ])
    execute(db, """
      UPDATE occurrences SET status='ringing', firstRingAt=COALESCE(firstRingAt, ?)
        WHERE id=? AND status IN ('scheduled','ringing')
      """, [
      String(Int64(firstRingAt)),
      occurrenceId
    ])
  }

  static func updateRearms(occurrenceId: String, count: Int) {
    let db = openDatabase()
    defer { sqlite3_close(db) }
    let tier = count >= 3 ? "brutal" : "standard"
    execute(db, "UPDATE occurrences SET rearms=?, tierReached=? WHERE id=? AND status='ringing'", [String(count), tier, occurrenceId])
  }

  static func resolve(occurrenceId: String, status: String) {
    guard ["bypassed", "abandoned", "completed"].contains(status) else { return }
    let db = openDatabase()
    defer { sqlite3_close(db) }
    execute(db, """
      UPDATE occurrences SET status=?,
        completedAt=CASE WHEN ?='completed' THEN COALESCE(completedAt, ?) ELSE completedAt END
      WHERE id=? AND status IN ('scheduled','ringing')
      """, [status, status, String(Int64(Date().timeIntervalSince1970 * 1000)), occurrenceId])
  }

  private static func openDatabase() -> OpaquePointer? {
    let directory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SQLite", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let path = directory.appendingPathComponent("wayykup-stats.db").path
    var database: OpaquePointer?
    guard sqlite3_open(path, &database) == SQLITE_OK else { return database }
    sqlite3_exec(database, """
      CREATE TABLE IF NOT EXISTS occurrences (
        id TEXT PRIMARY KEY NOT NULL, alarmId TEXT NOT NULL, localDate TEXT NOT NULL, tz TEXT NOT NULL,
        scheduledAt INTEGER NOT NULL, firstRingAt INTEGER, completedAt INTEGER,
        status TEXT NOT NULL CHECK (status IN ('scheduled','ringing','completed','bypassed','abandoned','missed','skipped')),
        challenge TEXT NOT NULL, difficulty INTEGER NOT NULL DEFAULT 1,
        tierReached TEXT NOT NULL DEFAULT 'gentle' CHECK (tierReached IN ('gentle','standard','brutal')),
        failedAttempts INTEGER NOT NULL DEFAULT 0, rearms INTEGER NOT NULL DEFAULT 0, soundId TEXT NOT NULL,
        morningRating INTEGER CHECK (morningRating BETWEEN 1 AND 5), shakesCounted INTEGER,
        challengeDurationMs INTEGER, UNIQUE (alarmId, localDate)
      );
      CREATE INDEX IF NOT EXISTS occurrences_localDate_idx ON occurrences(localDate);
      """, nil, nil, nil)
    return database
  }

  private static func execute(_ database: OpaquePointer?, _ sql: String, _ values: [String]) {
    guard let database else { return }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(statement) }
    for (index, value) in values.enumerated() {
      sqlite3_bind_text(statement, Int32(index + 1), value, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }
    let result = sqlite3_step(statement)
    if result != SQLITE_DONE && result != SQLITE_ROW {
      NSLog("WayykupAlarm database write failed: %s", sqlite3_errmsg(database))
    }
  }

  private static func normalizedChallenge(_ task: String) -> String {
    switch task {
    case "Yell to Stop": "yell_to_stop"
    case "Push-up Challenge": "push_up"
    case "Shake Your Phone": "shake_phone"
    case "Object Hunt": "object_hunt"
    default: "legacy"
    }
  }

  private static func normalizedSound(_ sound: String) -> String {
    sound.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
  }
}
