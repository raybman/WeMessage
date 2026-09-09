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
  binary "#{appdir}/WeMessage.app/Contents/MacOS/wemessaged", target: "wemessaged"
  binary "#{appdir}/WeMessage.app/Contents/MacOS/wemessage", target: "wemessage"

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
      WeMessage needs Full Disk Access and Automation permission for Messages
      to read and send messages. Grant both in System Settings > Privacy &
      Security before starting the service.

      Start the gateway service with:
        wemessage service install
    EOS
  end
end
