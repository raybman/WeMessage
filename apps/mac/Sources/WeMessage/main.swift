import Foundation
import WeMessageDaemonHost

// `--daemon` is checked before anything else runs, so the process launchd
// starts never reaches code meant for the window. S3 adds the window after
// this check, never before it.
if HostArguments.isDaemon(CommandLine.arguments) {
  exit(
    DaemonHost.run(
      argv: CommandLine.arguments, environment: ProcessInfo.processInfo.environment,
      executable: Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])))
}
FileHandle.standardError.write(Data("usage: WeMessage --daemon  (the window arrives in S3)\n".utf8))
exit(0)
