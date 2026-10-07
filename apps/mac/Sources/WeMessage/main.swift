import Foundation
import WeMessageDaemonHost
import WeMessageApp

// `--daemon` is checked before anything else runs, so the process launchd
// starts never reaches code meant for the window. S3 adds the window after
// this check, never before it.
if HostArguments.isDaemon(CommandLine.arguments) {
  exit(
    DaemonHost.run(
      argv: CommandLine.arguments, environment: ProcessInfo.processInfo.environment,
      executable: Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])))
}
AppEntry.run(environment: ProcessInfo.processInfo.environment)
