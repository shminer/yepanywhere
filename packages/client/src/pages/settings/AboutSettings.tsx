import { useCallback, useEffect, useState } from "react";
import { api, fetchJSON } from "../../api/client";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { activityBus } from "../../lib/activityBus";

export function AboutSettings() {
  const { canInstall, isInstalled, install } = usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const remoteConnection = useOptionalRemoteConnection();
  const { resetOnboarding } = useOnboarding();
  const { remoteLogCollectionEnabled, setRemoteLogCollectionEnabled } =
    useDeveloperMode();
  const isRelayConnection = !!remoteConnection?.currentRelayUsername;
  const hasResumeProtocolSupport =
    (versionInfo?.resumeProtocolVersion ?? 1) >= 2;
  const showRelayResumeUpdateWarning =
    isRelayConnection && !!versionInfo && !hasResumeProtocolSupport;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [activeWorkers, setActiveWorkers] = useState(0);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<{ activeWorkers: number; hasActiveWork: boolean }>(
      "/status/workers",
    )
      .then((data) => setActiveWorkers(data.activeWorkers))
      .catch(() => {});
  }, []);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
    });
  }, [restarting]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // Expected - server drops connection during restart
    }
  }, []);

  return (
    <section className="settings-section">
      <h2>About</h2>
      <div className="settings-group">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Install App</strong>
              <p>
                {isInstalled
                  ? "Yep Anywhere is installed on your device."
                  : "Add Yep Anywhere to your home screen for quick access."}
              </p>
            </div>
            {isInstalled ? (
              <span className="settings-status-badge">Installed</span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                Install
              </button>
            )}
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Version</strong>
            <p>
              Server:{" "}
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {versionInfo.updateAvailable && versionInfo.latest ? (
                    <span className="settings-update-available">
                      {" "}
                      (v{versionInfo.latest} available)
                    </span>
                  ) : versionInfo.latest ? (
                    <span className="settings-up-to-date"> (up to date)</span>
                  ) : null}
                </>
              ) : (
                "Loading..."
              )}
            </p>
            <p>Client: v{__APP_VERSION__}</p>
            {versionError && (
              <p className="settings-warning">
                Unable to refresh update status right now.
              </p>
            )}
            {showRelayResumeUpdateWarning && (
              <p className="settings-warning">
                Relay session resume requires a server update. New login works,
                but reconnect/resume will fail until the server is upgraded.
              </p>
            )}
            {versionInfo?.updateAvailable && (
              <p className="settings-update-hint">
                Run <code>npm i -g yepanywhere</code> to update
              </p>
            )}
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={() => void refetchVersionFresh()}
            disabled={versionLoading}
          >
            {versionLoading ? "Checking..." : "Check for Updates"}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Restart Server</strong>
            <p>Restart the backend server process.</p>
            {activeWorkers > 0 && !restarting && (
              <p className="settings-warning">
                {activeWorkers} active session
                {activeWorkers !== 1 ? "s" : ""} will be interrupted
              </p>
            )}
          </div>
          <button
            type="button"
            className={`settings-button ${activeWorkers > 0 ? "settings-button-danger" : ""}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? "Restarting..."
              : activeWorkers > 0
                ? "Restart Anyway"
                : "Restart Server"}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Report a Bug</strong>
            <p>
              Found an issue? Report it on GitHub to help improve Yep Anywhere.
            </p>
          </div>
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            Report Bug
          </a>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Setup Wizard</strong>
            <p>
              Run the initial setup wizard again to configure theme and remote
              access.
            </p>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={resetOnboarding}
          >
            Launch Wizard
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Connection Diagnostics</strong>
            <p>Capture connection logs and send to server for debugging.</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </section>
  );
}
