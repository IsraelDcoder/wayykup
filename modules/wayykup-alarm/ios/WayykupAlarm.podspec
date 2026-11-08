require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'WayykupAlarm'
  s.version        = package['version']
  s.summary        = 'Native OS-owned alarm scheduling and ringing for Wayykup.'
  s.description    = s.summary
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'Wayykup'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/expo/expo.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.libraries = 'sqlite3'
  s.source_files = 'WayykupAlarmModule.swift'
end
