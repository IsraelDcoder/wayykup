import ActivityKit
import AlarmKit
import SwiftUI
import WidgetKit
import WayykupAlarm

@main
struct WayykupAlarmWidgetBundle: WidgetBundle {
  var body: some Widget {
    WayykupAlarmLiveActivity()
  }
}

struct WayykupAlarmLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AlarmAttributes<WayykupAlarmMetadata>.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        Text("WAYYKUP · TIME TO GET UP")
          .font(.headline.weight(.heavy))
        Text(context.attributes.metadata.challenge)
          .font(.title2.weight(.bold))
        Text("Complete your challenge to stop the alarm.")
          .font(.subheadline)
      }
      .padding()
      .activityBackgroundTint(Color.black)
      .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.center) {
          Text("WAYYKUP · \(context.attributes.metadata.challenge.uppercased())")
            .font(.headline.weight(.heavy))
        }
      } compactLeading: {
        Image(systemName: "alarm.fill")
          .foregroundStyle(Color.orange)
      } compactTrailing: {
        Text("UP")
          .font(.caption.weight(.black))
      } minimal: {
        Image(systemName: "alarm.fill")
          .foregroundStyle(Color.orange)
      }
    }
  }
}
