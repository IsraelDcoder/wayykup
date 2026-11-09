import ExpoModulesCore
import Foundation
import SQLite3
import UIKit
import UserNotifications
import Vision
import AVFoundation

#if canImport(AlarmKit)
import AlarmKit
import AppIntents
import SwiftUI
#endif

public final class WayykupAlarmModule: Module {
  private let microphoneMeter = MicrophoneMeter()

  public func definition() -> ModuleDefinition {
    Name("WayykupAlarm")
    Events("ringStarted", "challengeCompleted", "healthChanged", "microphoneLevel", "microphoneError")

    AsyncFunction("schedule") { (alarm: [String: Any]) async throws in
      try await NativeAlarmScheduler.schedule(alarm)
    }

    AsyncFunction("classifyImage") { (uri: String) throws -> [[String: Any]] in
      guard let url = URL(string: uri), url.isFileURL else {
        throw NativeAlarmError.invalidAlarm("Wayykup could not access the captured object photo.")
      }
      let request = VNClassifyImageRequest()
      try VNImageRequestHandler(url: url, options: [:]).perform([request])
      return (request.results ?? []).prefix(12).map { observation -> [String: Any] in
        [
          "label": observation.identifier,
          "confidence": Double(observation.confidence)
        ]
      }
    }

    AsyncFunction("importSound") { (uri: String, name: String) throws -> [String: String] in
      guard let source = URL(string: uri), source.isFileURL else {
        throw NativeAlarmError.invalidAlarm("Wayykup could not access the selected audio file.")
      }
      let fileExtension = source.pathExtension.isEmpty
        ? URL(fileURLWithPath: name).pathExtension.lowercased()
        : source.pathExtension.lowercased()
      guard ["mp3", "m4a", "aac", "wav", "caf", "aiff", "aif"].contains(fileExtension) else {
        throw NativeAlarmError.invalidAlarm("Choose an MP3, M4A, AAC, WAV, CAF, or AIFF audio file.")
      }
      if let attributes = try? FileManager.default.attributesOfItem(atPath: source.path),
         let size = attributes[.size] as? NSNumber,
         size.int64Value > 100 * 1024 * 1024 {
        throw NativeAlarmError.invalidAlarm("Choose an audio file smaller than 100 MB.")
      }
      let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      let directory = library.appendingPathComponent("Sounds", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let destination = directory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
      let hasScopedAccess = source.startAccessingSecurityScopedResource()
      defer {
        if hasScopedAccess { source.stopAccessingSecurityScopedResource() }
      }
      try FileManager.default.copyItem(at: source, to: destination)
      return [
        "uri": destination.absoluteString,
        "name": destination.lastPathComponent,
        "displayName": URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent
      ]
    }

    AsyncFunction("cancel") { (alarmId: String) async throws in
      try await NativeAlarmScheduler.cancel(alarmId: alarmId, removeDefinition: true)
    }

    AsyncFunction("rearm") { (alarmId: String, delaySeconds: Double) async throws in
      try await NativeAlarmScheduler.rearm(alarmId: alarmId, delaySeconds: delaySeconds)
    }

    AsyncFunction("cancelChain") { (alarmId: String, status: String) async throws in
      let ring = NativeAlarmScheduler.pendingRing
      try await NativeAlarmScheduler.cancelChain(alarmId: alarmId, status: status)
      self.sendEvent("challengeCompleted", [
        "alarmId": alarmId,
        "occurrenceId": ring?["occurrenceId"] as? String ?? ""
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

    AsyncFunction("startTestAlarm") async throws {
      try await NativeAlarmScheduler.scheduleTest()
    }

    AsyncFunction("startMicrophoneMeter") throws {
      try self.microphoneMeter.start { dbfs in
        self.sendEvent("microphoneLevel", ["dbfs": dbfs])
      }
    }

    AsyncFunction("stopMicrophoneMeter") {
      self.microphoneMeter.stop()
    }

    AsyncFunction("setAlarmAudioDucked") { (_: Bool, _: Double) throws in
      throw NSError(domain: "WayykupAlarmAudio", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "iOS AlarmKit does not expose runtime alarm volume control."
      ])
    }

    OnDestroy {
      self.microphoneMeter.stop()
    }
  }
}

private final class MicrophoneMeter {
  private let engine = AVAudioEngine()
  private var isRunning = false

  func start(onLevel: @escaping (Double) -> Void) throws {
    guard !isRunning else { return }
    let session = AVAudioSession.sharedInstance()
    let input = engine.inputNode
    var tapInstalled = false
    do {
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      guard let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {
        throw NSError(domain: "WayykupMicrophoneMeter", code: 2, userInfo: [
          NSLocalizedDescriptionKey: "The built-in microphone is unavailable."
        ])
      }
      try session.setPreferredInput(builtInMic)
      let format = input.outputFormat(forBus: 0)
      guard format.channelCount > 0 else {
        throw NSError(domain: "WayykupMicrophoneMeter", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "The built-in microphone is unavailable."
        ])
      }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        guard let channel = buffer.floatChannelData?.pointee else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sumSquares = 0.0
        for index in 0..<count {
          let value = Double(channel[index])
          sumSquares += value * value
        }
        let rms = sqrt(sumSquares / Double(count))
        let dbfs = rms <= 0.00001 ? -100.0 : max(-100.0, 20.0 * log10(rms))
        onLevel(dbfs)
      }
      tapInstalled = true
      engine.prepare()
      try engine.start()
      isRunning = true
    } catch {
      if tapInstalled { input.removeTap(onBus: 0) }
      engine.stop()
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }
  }

  func stop() {
    guard isRunning else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    isRunning = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

private enum NativeAlarmScheduler {
  private static let prefs = UserDefaults.standard
  private static let alarmsKey = "wayykup_native_alarms"
  private static let pendingKey = "wayykup_pending_ring"
  private static let testPassedKey = "wayykup_test_alarm_passed"
  private static let testAlarmId = "__wayykup_test_alarm__"

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
    let currentHealth = await health()
    guard currentHealth["canSchedule"] as? Bool == true else {
      throw NativeAlarmError.permissionDenied
    }
    prefs.set(alarm, forKey: "\(alarmsKey).\(alarmId)")
    guard alarm["enabled"] as? Bool != false else {
      try await cancel(alarmId: alarmId, removeDefinition: true)
      return
    }
    let date = try nextDate(for: alarm, after: Date())
    NSLog(
      "WayykupAlarm event=scheduled alarmId=%@ scheduledAt=%.0f device=%@ os=%@",
      alarmId,
      date.timeIntervalSince1970 * 1000,
      deviceModel,
      ProcessInfo.processInfo.operatingSystemVersionString
    )
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      try await scheduleAlarmKit(alarm, alarmId: alarmId, date: date)
      return
    }
    #endif
    try await scheduleNotificationFallback(alarm, alarmId: alarmId, date: date)
  }

  static func cancel(alarmId: String, removeDefinition: Bool) async throws {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      let ids = (prefs.array(forKey: chainKey(alarmId)) as? [String] ?? [])
      for value in ids {
        guard let id = UUID(uuidString: value) else { continue }
        try AlarmManager.shared.cancel(id: id)
      }
      if let value = prefs.string(forKey: alarmKitIdKey(alarmId)), let id = UUID(uuidString: value) {
        try AlarmManager.shared.cancel(id: id)
      }
    }
    #endif
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: notificationIds(alarmId))
    center.removeDeliveredNotifications(withIdentifiers: notificationIds(alarmId))
    prefs.removeObject(forKey: chainKey(alarmId))
    if removeDefinition {
      prefs.removeObject(forKey: "\(alarmsKey).\(alarmId)")
      prefs.removeObject(forKey: alarmKitIdKey(alarmId))
    }
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

  static func cancelChain(alarmId: String, status: String) async throws {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      for value in prefs.array(forKey: chainKey(alarmId)) as? [String] ?? [] {
        guard let id = UUID(uuidString: value) else { continue }
        try AlarmManager.shared.cancel(id: id)
      }
    }
    #endif
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: chainNotificationIds(alarmId))
    prefs.removeObject(forKey: chainKey(alarmId))
    let isTestAlarm = pendingRing?["testAlarm"] as? Bool == true || alarmId.hasPrefix(testAlarmId)
    if status == "completed", isTestAlarm {
      prefs.set(true, forKey: testPassedKey)
    }
    if let occurrenceId = pendingRing?["occurrenceId"] as? String {
      NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: status)
    }
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
      "task": "Math",
      "sound": "Air raid",
      "mathDifficulty": "Easy",
      "testAlarm": true
    ]
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

  private static func chainNotificationIds(_ alarmId: String) -> [String] {
    (0..<24).map { "wayykup.\(alarmId).rearm.\($0)" }
  }

  private static func chainKey(_ alarmId: String) -> String { "wayykup_chain_\(alarmId)" }
  private static func alarmKitIdKey(_ alarmId: String) -> String { "wayykup_alarmkit_\(alarmId)" }

  private static func scheduleNotificationFallback(_ alarm: [String: Any], alarmId: String, date: Date) async throws {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests()
    let related = Set(notificationIds(alarmId))
    let available = pending.filter { !related.contains($0.identifier) }.count
    guard available + 25 <= 64 else {
      throw NativeAlarmError.tooManyNotifications
    }
    center.removePendingNotificationRequests(withIdentifiers: notificationIds(alarmId))
    let occurrenceId = occurrenceIdentifier(alarmId: alarmId, date: date)
    let firstRingAt = date.timeIntervalSince1970
    let baseContent = notificationContent(alarm: alarm, occurrenceId: occurrenceId, scheduledAt: firstRingAt)
    try await center.add(
      UNNotificationRequest(
        identifier: "wayykup.\(alarmId).base",
        content: baseContent,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
      )
    )
    for index in 0..<24 {
      var content = notificationContent(alarm: alarm, occurrenceId: occurrenceId, scheduledAt: firstRingAt)
      content.title = "WAYYKUP · ALARM CONTINUES"
      content.body = "Your wake-up challenge is still waiting."
      try await center.add(
        UNNotificationRequest(
          identifier: "wayykup.\(alarmId).rearm.\(index)",
          content: content,
          trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow) + Double((index + 1) * 75), repeats: false)
        )
      )
    }
    prefs.set(["\(alarmId):\(occurrenceId)"], forKey: chainKey(alarmId))
  }

  private static func scheduleNotificationRearm(alarmId: String, delaySeconds: Double) async throws {
    guard let alarm = prefs.dictionary(forKey: "\(alarmsKey).\(alarmId)") else { return }
    let now = Date()
    if let start = prefs.object(forKey: "wayykup_chain_started_\(alarmId)") as? Date,
       now.timeIntervalSince(start) >= 30 * 60 {
      if let occurrenceId = pendingRing?["occurrenceId"] as? String {
        NativeOccurrenceStore.resolve(occurrenceId: occurrenceId, status: "bypassed")
      }
      return
    }
    try await scheduleNotificationFallback(alarm, alarmId: alarmId, date: now.addingTimeInterval(delaySeconds))
  }

  private static func notificationContent(alarm: [String: Any], occurrenceId: String, scheduledAt: TimeInterval) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "WAYYKUP · TIME TO GET UP"
    content.body = "\(alarm["task"] as? String ?? "Wake-up") challenge. Prove you are awake."
    if let customSoundName = alarm["customSoundName"] as? String {
      content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: customSoundName))
    } else {
      content.sound = .default
    }
    content.interruptionLevel = .timeSensitive
    content.userInfo = [
      "alarmId": alarm["id"] as? String ?? "",
      "occurrenceId": occurrenceId,
      "scheduledAt": scheduledAt,
      "timeZone": TimeZone.current.identifier,
      "challenge": alarm["task"] as? String ?? "Math",
      "sound": alarm["sound"] as? String ?? "Air raid"
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
      challenge: alarm["task"] as? String ?? "Math",
      sound: alarm["sound"] as? String ?? "Air raid",
      scheduledAt: date.timeIntervalSince1970 * 1000,
      timeZone: TimeZone.current.identifier
    )
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource("WAYYKUP · TIME TO GET UP"),
      stopButton: AlarmButton(text: LocalizedStringResource("Stop"), textColor: .white, systemImageName: "stop.fill"),
      secondaryButton: AlarmButton(text: LocalizedStringResource("Prove it"), textColor: .white, systemImageName: "arrow.up.forward.app"),
      secondaryButtonBehavior: .custom
    )
    let attributes = AlarmAttributes(
      presentation: AlarmPresentation(alert: alert),
      metadata: metadata,
      tintColor: Color.orange
    )
    let configuration = AlarmManager.AlarmConfiguration(
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
      sound: AlertConfiguration.AlertSound.named(
        alarm["customSoundName"] as? String ?? soundResource(for: metadata.sound)
      )
    )
    try AlarmManager.shared.schedule(id: id, configuration: configuration)
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
      challenge: alarm["task"] as? String ?? "Math",
      sound: alarm["sound"] as? String ?? "Air raid",
      scheduledAt: now.timeIntervalSince1970 * 1000,
      timeZone: pendingRing?["timeZone"] as? String ?? TimeZone.current.identifier
    )
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource("WAYYKUP · ALARM CONTINUES"),
      stopButton: AlarmButton(text: LocalizedStringResource("Stop"), textColor: .white, systemImageName: "stop.fill"),
      secondaryButton: AlarmButton(text: LocalizedStringResource("Prove it"), textColor: .white, systemImageName: "arrow.up.forward.app"),
      secondaryButtonBehavior: .custom
    )
    let attributes = AlarmAttributes(
      presentation: AlarmPresentation(alert: alert),
      metadata: metadata,
      tintColor: Color.orange
    )
    let configuration = AlarmManager.AlarmConfiguration(
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
      sound: AlertConfiguration.AlertSound.named(
        alarm["customSoundName"] as? String ?? soundResource(for: metadata.sound)
      )
    )
    try AlarmManager.shared.schedule(id: id, configuration: configuration)
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
    timeZone: String
  ) {
    let at = Date().timeIntervalSince1970 * 1000
    let ring: [String: Any] = [
      "alarmId": alarmId,
      "occurrenceId": occurrenceId,
      "at": at,
      "scheduledAt": scheduledAt,
      "timeZone": timeZone,
      "challenge": challenge,
      "sound": sound,
      "testAlarm": alarmId == testAlarmId
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

  private static func soundResource(for sound: String) -> String {
    let key = sound.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    let names = [
      "dread_siren": "dread-siren.wav",
      "panic_engine": "panic-engine.wav",
      "nightmare": "nightmare.wav",
      "final_warning": "final-warning.wav",
      "air_raid": "alarm-tone.wav",
      "beacon": "beacon.wav",
      "buzz_saw": "buzz-saw.wav",
      "kitchen_phone": "kitchen-phone.wav",
      "pulse": "pulse.wav",
      "honk": "honk.wav",
      "inferno": "inferno.wav",
      "redline": "redline.wav",
      "bugle_call": "bugle-call.wav",
      "countdown": "countdown.wav",
      "jackhammer": "jackhammer.wav",
      "warpath": "warpath.wav"
    ]
    return names[key] ?? "alarm-tone.wav"
  }
  #endif
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
public struct WayykupAlarmMetadata: AlarmMetadata, Codable, Hashable {
  public let alarmId: String
  public let occurrenceId: String
  public let challenge: String
  public let sound: String
  public let scheduledAt: Double
  public let timeZone: String

  public init(
    alarmId: String,
    occurrenceId: String,
    challenge: String,
    sound: String,
    scheduledAt: Double,
    timeZone: String
  ) {
    self.alarmId = alarmId
    self.occurrenceId = occurrenceId
    self.challenge = challenge
    self.sound = sound
    self.scheduledAt = scheduledAt
    self.timeZone = timeZone
  }
}

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
      timeZone: timeZone
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
      timeZone: timeZone
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
        morningRating INTEGER CHECK (morningRating BETWEEN 1 AND 5), shakesCounted INTEGER, steps INTEGER,
        mathCorrect INTEGER, mathAttempts INTEGER, challengeDurationMs INTEGER, UNIQUE (alarmId, localDate)
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
    case "Math": "math"
    case "Shake": "shake"
    case "QR scan": "qr"
    case "Memory": "memory"
    case "Object Hunt": "object_hunt"
    case "Toothbrush": "toothbrush"
    case "Yell to Wake": "yell"
    case "Face Challenge": "face"
    default: "exercise"
    }
  }

  private static func normalizedSound(_ sound: String) -> String {
    sound.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
  }
}
