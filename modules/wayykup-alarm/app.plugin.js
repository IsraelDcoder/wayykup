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

function withEasWidgetExtension(config) {
  const appBundleIdentifier = config.ios?.bundleIdentifier;
  if (!appBundleIdentifier) {
    throw new Error('Wayykup needs an iOS bundle identifier to configure its AlarmKit widget for EAS signing.');
  }

  const bundleIdentifier = `${appBundleIdentifier}.alarmkit-widget`;
  const appExtensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  const existing = appExtensions.find((extension) => extension.targetName === WIDGET_TARGET);
  if (existing) {
    if (existing.bundleIdentifier !== bundleIdentifier) {
      throw new Error(
        `Wayykup AlarmKit widget EAS bundle identifier must be ${bundleIdentifier}, not ${existing.bundleIdentifier}.`,
      );
    }
    return config;
  }

  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: {
            ...config.extra?.eas?.build?.experimental?.ios,
            appExtensions: [
              ...appExtensions,
              {
                targetName: WIDGET_TARGET,
                bundleIdentifier,
                entitlements: {},
              },
            ],
          },
        },
      },
    },
  };
  return config;
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

function withWayykupPodTargets(config) {
  return withPodfile(config, (mod) => {
    const targetName = mod.ios?.name ?? 'Wayykup';
    const escapedTargetName = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetOpening = new RegExp(`^([\\t ]*)target\\s+['"]${escapedTargetName}['"]\\s+do\\s*$`, 'm');
    const widgetTargetPattern = new RegExp(`target\\s+['"]${WIDGET_TARGET}['"]\\s+do\\b`);
    const legacyWidgetTarget = new RegExp(
      `\\n[\\t ]*target\\s+['"]${WIDGET_TARGET}['"]\\s+do\\s*\\n[\\t ]*pod\\s+['"]WayykupAlarm['"],\\s*:path\\s*=>\\s*['"]\\.\\./modules/wayykup-alarm/ios['"]\\s*\\n[\\t ]*end\\s*$`,
    );
    // RevenueCat 11.0.1 pins this version, which is not available from CocoaPods trunk.
    const revenueCatPod = "pod 'PurchasesHybridCommon', :git => 'https://github.com/RevenueCat/purchases-hybrid-common.git', :tag => '20.4.0'";
    const widgetPod = "pod 'WayykupAlarm', :path => '../modules/wayykup-alarm/ios'";
    const contents = mod.modResults.contents.replace(legacyWidgetTarget, '');

    if (contents.includes("pod 'PurchasesHybridCommon'") && widgetTargetPattern.test(contents)) return mod;
    const targetMatch = targetOpening.exec(contents);
    if (!targetMatch) {
      throw new Error(`Wayykup could not find the ${targetName} target in its iOS Podfile.`);
    }

    const indent = targetMatch[1];
    const additions = [];
    if (!contents.includes("pod 'PurchasesHybridCommon'")) {
      additions.push(`${indent}  ${revenueCatPod}`);
    }
    if (!widgetTargetPattern.test(contents)) {
      additions.push([
        `${indent}  target '${WIDGET_TARGET}' do`,
        `${indent}    inherit! :search_paths`,
        `${indent}    ${widgetPod}`,
        `${indent}  end`,
      ].join('\n'));
    }
    mod.modResults.contents = contents.replace(targetOpening, (match) => `${match}\n${additions.join('\n')}`);
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
    const widgetNativeTarget = target[1];
    const appTargetEntry = Object.entries(project.pbxNativeTargetSection())
      .find(([, value]) => value.productType?.replaceAll('"', '') === 'com.apple.product-type.application');
    if (!appTargetEntry) throw new Error('Wayykup could not find the iOS app target to host its alarm widget.');
    const [appTargetUuid, appNativeTarget] = appTargetEntry;
    const projectObjects = project.hash.project.objects;
    projectObjects.PBXTargetDependency ??= {};
    projectObjects.PBXContainerItemProxy ??= {};
    const targetDependencies = projectObjects.PBXTargetDependency;
    const hasWidgetDependency = (appNativeTarget.dependencies ?? []).some(({ value }) =>
      targetDependencies[value]?.target === targetUuid,
    );
    if (!hasWidgetDependency) {
      project.addTargetDependency(appTargetUuid, [targetUuid]);
      const dependencyAdded = (appNativeTarget.dependencies ?? []).some(({ value }) =>
        targetDependencies[value]?.target === targetUuid,
      );
      if (!dependencyAdded) throw new Error('Wayykup could not link the alarm widget to its host app target.');
    }

    const buildFiles = project.pbxBuildFileSection();
    const fileReferences = project.pbxFileReferenceSection();
    let copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase ?? {};
    const embeddedWidget = (appNativeTarget.buildPhases ?? []).some(({ value }) => {
      const phase = copyPhases[value];
      return phase?.dstSubfolderSpec === 13 && (phase.files ?? []).some(({ value: buildFileUuid }) =>
        buildFiles[buildFileUuid]?.fileRef === widgetNativeTarget.productReference,
      );
    });
    if (!embeddedWidget) {
      let embedPhase = (appNativeTarget.buildPhases ?? [])
        .map(({ value }) => copyPhases[value])
        .find((phase) => phase?.dstSubfolderSpec === 13);
      if (!embedPhase) {
        project.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed App Extensions', appTargetUuid, 'app_extension');
        copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase ?? {};
        embedPhase = (appNativeTarget.buildPhases ?? [])
          .map(({ value }) => copyPhases[value])
          .find((phase) => phase?.dstSubfolderSpec === 13);
      }
      if (!embedPhase) throw new Error('Wayykup could not create the alarm widget embedding build phase.');

      const productReference = fileReferences[widgetNativeTarget.productReference];
      if (!productReference) throw new Error('Wayykup could not find the alarm widget product in the Xcode project.');
      const productName = productReference.name?.replaceAll('"', '') ?? `${WIDGET_TARGET}.appex`;
      const buildFile = {
        uuid: project.generateUuid(),
        fileRef: widgetNativeTarget.productReference,
        basename: productName,
        group: 'Embed App Extensions',
      };
      project.addToPbxBuildFileSection(buildFile);
      embedPhase.files.push({ value: buildFile.uuid, comment: `${productName} in Embed App Extensions` });
    }

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
  config = withEasWidgetExtension(config);
  config = withAlarmKitInfo(config);
  config = withAndroidAlarmActivity(config);
  config = withWayykupPodTargets(config);
  return withAlarmKitWidget(config);
};
