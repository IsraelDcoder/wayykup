const fs = require('node:fs');
const path = require('node:path');
const {
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
  withPodfile,
  withXcodeProject,
} = require('@expo/config-plugins');

const WIDGET_TARGET = 'WayykupAlarmWidgetExtension';
const SOUND_FILES = [
  'alarm-tone.wav',
  'beacon.wav',
  'bugle-call.wav',
  'buzz-saw.wav',
  'countdown.wav',
  'dread-siren.wav',
  'final-warning.wav',
  'honk.wav',
  'inferno.wav',
  'jackhammer.wav',
  'kitchen-phone.wav',
  'nightmare.wav',
  'panic-engine.wav',
  'pulse.wav',
  'redline.wav',
  'warpath.wav',
];

function withAlarmKitInfo(config) {
  return withInfoPlist(config, (mod) => {
    mod.modResults.NSAlarmKitUsageDescription =
      'Wayykup uses AlarmKit to ring scheduled wake-up alarms and open their challenges.';
    mod.modResults.NSSupportsLiveActivities = true;
    return mod;
  });
}

function withAndroidAlarmActivity(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Wayykup alarm setup could not find the Android application manifest entry.');
    const mainActivity = application.activity?.find((activity) =>
      activity.$['android:name']?.endsWith('MainActivity'),
    );
    if (!mainActivity) throw new Error('Wayykup alarm setup could not find the Android MainActivity.');
    mainActivity.$['android:showWhenLocked'] = 'true';
    mainActivity.$['android:turnScreenOn'] = 'true';
    mainActivity.$['android:excludeFromRecents'] = 'false';
    return mod;
  });
}

function withRevenueCatHybridCommon(config) {
  return withPodfile(config, (mod) => {
    const targetName = mod.ios?.name ?? 'Wayykup';
    const escapedTargetName = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetOpening = new RegExp(`(^[\\t ]*target\\s+['"]${escapedTargetName}['"]\\s+do\\s*$)`, 'm');
    // RevenueCat 11.0.1 pins this version, which is not available from CocoaPods trunk.
    const podDeclaration = "  pod 'PurchasesHybridCommon', :git => 'https://github.com/RevenueCat/purchases-hybrid-common.git', :tag => '20.4.0'";
    const contents = mod.modResults.contents;

    if (contents.includes("pod 'PurchasesHybridCommon'")) return mod;
    if (!targetOpening.test(contents)) {
      throw new Error(`Wayykup could not find the ${targetName} target in its iOS Podfile.`);
    }

    mod.modResults.contents = contents.replace(targetOpening, `$1\n${podDeclaration}`);
    return mod;
  });
}

function withAlarmKitWidget(config) {
  config = withDangerousMod(config, ['ios', async (mod) => {
    const projectRoot = mod.modRequest.platformProjectRoot;
    const projectName = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
    const widgetDirectory = path.join(projectRoot, WIDGET_TARGET);
    const appDirectory = path.join(projectRoot, projectName);
    fs.mkdirSync(widgetDirectory, { recursive: true });
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, 'ios', 'WayykupAlarmWidget.swift'),
      path.join(widgetDirectory, 'WayykupAlarmWidget.swift'),
    );
    fs.writeFileSync(
      path.join(widgetDirectory, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict></plist>`,
    );
    for (const file of SOUND_FILES) {
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'assets', file), path.join(appDirectory, file));
    }

    const podfile = path.join(projectRoot, 'Podfile');
    let podfileText = fs.readFileSync(podfile, 'utf8');
    if (!podfileText.includes(`target '${WIDGET_TARGET}'`)) {
      podfileText += `\n\ntarget '${WIDGET_TARGET}' do\n  pod 'WayykupAlarm', :path => '../modules/wayykup-alarm/ios'\nend\n`;
      fs.writeFileSync(podfile, podfileText);
    }
    return mod;
  }]);

  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
    let target = Object.entries(project.pbxNativeTargetSection())
      .find(([, value]) => value.name?.replaceAll('"', '') === WIDGET_TARGET);
    if (!target) {
      const added = project.addTarget(
        WIDGET_TARGET,
        'app_extension',
        WIDGET_TARGET,
        `${mod.ios?.bundleIdentifier}.alarmkit-widget`,
      );
      target = [added.uuid, added.pbxNativeTarget];
      project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', added.uuid);
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', added.uuid);
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    }
    const targetUuid = target[0];
    const widgetFile = `${WIDGET_TARGET}/WayykupAlarmWidget.swift`;
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: widgetFile,
      groupName: projectName,
      project,
      targetUuid,
    });
    for (const file of SOUND_FILES) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: `${projectName}/${file}`,
        groupName: projectName,
        project,
      });
    }
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${WIDGET_TARGET}/Info.plist`,
      groupName: projectName,
      project,
    });
    for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) {
      if (entry.buildSettings?.PRODUCT_NAME?.replaceAll('"', '') !== WIDGET_TARGET) continue;
      Object.assign(entry.buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CODE_SIGN_STYLE: 'Automatic',
        GENERATE_INFOPLIST_FILE: 'NO',
        INFOPLIST_FILE: `${WIDGET_TARGET}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET: '26.0',
        PRODUCT_BUNDLE_IDENTIFIER: `${mod.ios?.bundleIdentifier}.alarmkit-widget`,
        PRODUCT_NAME: WIDGET_TARGET,
        SKIP_INSTALL: 'YES',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '"1,2"',
      });
    }
    return mod;
  });
}

module.exports = function withWayykupAlarm(config) {
  config = withAlarmKitInfo(config);
  config = withAndroidAlarmActivity(config);
  config = withRevenueCatHybridCommon(config);
  return withAlarmKitWidget(config);
};
