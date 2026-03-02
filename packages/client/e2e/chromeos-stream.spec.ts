/**
 * E2E test for ChromeOS WebRTC streaming.
 *
 * Requires:
 *   - CHROMEOS_HOST to be set (script defaults to "chromeroot")
 *   - SSH connectivity to CHROMEOS_HOST
 *   - daemon.py present at /mnt/stateful_partition/c2/daemon.py
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");
const CHROMEOS_DAEMON_PATH = "/mnt/stateful_partition/c2/daemon.py";

function canSSH(host: string): boolean {
  try {
    execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"],
      { timeout: 8000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function hasDaemon(host: string): boolean {
  try {
    execFileSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        host,
        "test",
        "-f",
        CHROMEOS_DAEMON_PATH,
      ],
      { timeout: 8000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

test("streams ChromeOS video over WebRTC when host is configured", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const host = process.env.CHROMEOS_HOST?.trim();
  test.skip(
    !host,
    "CHROMEOS_HOST not set — run with CHROMEOS_HOST=chromeroot",
  );

  test.skip(!canSSH(host), `Cannot SSH to ${host}`);
  test.skip(
    !hasDaemon(host),
    `ChromeOS daemon missing at ${CHROMEOS_DAEMON_PATH} on ${host}`,
  );

  await page.goto(`${baseURL}/emulator`);

  const deviceLabel = `ChromeOS (${host})`;
  const row = page.locator(".emulator-list-item", { hasText: deviceLabel });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: "Connect" }).click();

  await expect(page.locator(".emulator-connection-state")).toHaveText(
    "connected",
    { timeout: 30_000 },
  );

  const video = page.locator("video.emulator-video");
  await expect(video).toBeVisible();

  await expect(async () => {
    const readyState = await page.evaluate(
      () =>
        (
          document.querySelector(
            "video.emulator-video",
          ) as HTMLVideoElement | null
        )?.readyState ?? 0,
    );
    expect(readyState).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});
