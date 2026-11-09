#if canImport(AlarmKit)
import AlarmKit
import Foundation

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
#endif
