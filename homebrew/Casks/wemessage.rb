cask "wemessage" do
  version "1.0.0-rc.1"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/raybman/WeMessage/releases/download/v#{version}/WeMessage-#{version}-arm64-UNSIGNED.dmg"
  name "WeMessage"
  desc "Local gateway service that bridges iMessage to WeMessage clients"
  homepage "https://github.com/raybman/WeMessage"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :sequoia
  depends_on arch: :arm64

  app "WeMessage.app"
  binary "#{appdir}/WeMessage.app/Contents/Resources/bin/wemessaged", target: "wemessaged"
  binary "#{appdir}/WeMessage.app/Contents/Resources/bin/wemessage", target: "wemessage"

  uninstall launchctl: "sh.wemessage.gateway",
            quit:      "sh.wemessage.gateway",
            delete:    "~/Library/LaunchAgents/sh.wemessage.gateway.plist"

  zap trash: [
    "~/Library/Application Support/WeMessage",
    "~/Library/Logs/WeMessage",
    "~/Library/Preferences/sh.wemessage.gateway.plist",
    "~/Library/Saved Application State/sh.wemessage.gateway.savedState",
  ]

  caveats do
    <<~EOS
      This build is UNSIGNED and Homebrew quarantines what it downloads, so
      macOS will refuse the first launch. To allow it:

        1. Open WeMessage once and let macOS refuse it.
        2. Open System Settings > Privacy & Security, scroll to the bottom,
           and click "Open Anyway" next to the message about WeMessage.
        3. Open it again and confirm.

      Or, in a terminal:
        xattr -d com.apple.quarantine /Applications/WeMessage.app

      WeMessage needs Full Disk Access and Automation permission for Messages
      to read and send messages. Grant both in System Settings > Privacy &
      Security before starting the service.

      Start the gateway service with:
        wemessaged service install
    EOS
  end
end
