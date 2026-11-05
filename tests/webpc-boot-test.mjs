import { chromium } from "playwright";
import fs from "node:fs";

const baseUrl = (process.env.WEPC_BASE_URL || process.env.WEBPC_BASE_URL ||
  "https://webpc.bowslicegames.workers.dev").replace(/\/$/, "");
const explicitRelease = (process.env.WEBPC_EXPECTED_RELEASE || "").trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

async function getExpectedRelease() {
  if (explicitRelease) return explicitRelease;
  const response = await fetch(baseUrl + "/worker-test", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Worker diagnostics returned HTTP " + response.status);
  const html = await response.text();
  const match = html.match(/QEMU runtime release:[^>]*>([^<\s]+)/i);
  if (!match) throw new Error("Could not read the active QEMU release tag from /worker-test");
  return match[1];
}

async function waitForRelease(expected) {
  const deadline = Date.now() + 180000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + "/assets/out.js", {
        redirect: "follow",
        signal: AbortSignal.timeout(30000)
      });
      last = "HTTP " + response.status + ", X-WebPC-Release=" +
        (response.headers.get("X-WebPC-Release") || "(missing)");
      if (response.ok && response.headers.get("X-WebPC-Release") === expected) {
        await response.body?.cancel();
        console.log("Worker release route is live:", expected);
        return;
      }
      await response.body?.cancel();
    } catch (error) {
      last = String(error);
    }
    console.log("Waiting for Worker release route:", last);
    await wait(5000);
  }
  throw new Error("Worker did not serve expected QEMU release " + expected + "; last probe: " + last);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--no-sandbox"]
});

try {
  const expectedRelease = await getExpectedRelease();
  await waitForRelease(expectedRelease);

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => pageErrors.push(error.stack || error.message));
  page.on("requestfailed", request => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText || "unknown"
  }));

  console.log("Opening WebPC in a clean, isolated Chromium profile:", baseUrl);
  const response = await page.goto(baseUrl + "/", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  if (!response || !response.ok()) {
    throw new Error("WebPC page returned HTTP " + (response?.status() ?? "no response"));
  }

  const browserCaps = await page.evaluate(async () => ({
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    opfs: !!(navigator.storage && navigator.storage.getDirectory),
    quota: (await navigator.storage.estimate().catch(() => ({}))).quota || 0
  }));
  console.log("Browser capabilities:", JSON.stringify(browserCaps));
  if (!browserCaps.secureContext || !browserCaps.crossOriginIsolated ||
      !browserCaps.sharedArrayBuffer || !browserCaps.opfs) {
    throw new Error("Browser lacks a required WebPC capability: " + JSON.stringify(browserCaps));
  }

  await page.waitForFunction(() => {
    const login = document.querySelector("#webpcLoginScreen");
    const error = document.querySelector("#errorBox")?.innerText || "";
    const detail = document.querySelector("#stageDetail")?.innerText || "";
    return !!login?.classList.contains("visible") ||
      detail.includes("Linux shell detected") ||
      error.includes("WEBPC 2 STARTUP ERROR");
  }, null, { timeout: 480000, polling: 1000 });

  const result = await page.evaluate(() => ({
    loginVisible: !!document.querySelector("#webpcLoginScreen")?.classList.contains("visible"),
    serial: document.querySelector("#webpcSerialLog")?.innerText || "",
    bootSignal: document.querySelector("#linuxBootSignal")?.innerText || "",
    stage: document.querySelector("#mainStage")?.innerText ||
      document.querySelector("#startupStage")?.innerText || "",
    detail: document.querySelector("#stageDetail")?.innerText || "",
    error: document.querySelector("#errorBox")?.innerText || "",
    diskStatus: document.body.innerText.match(/Persistent OPFS disk ready:[^\n]*/)?.[0] || ""
  }));

  console.log("Guest boot result:", JSON.stringify(result, null, 2));
  if (result.error.includes("WEBPC 2 STARTUP ERROR") || !result.loginVisible &&
      !result.detail.includes("Linux shell detected")) {
    throw new Error("Guest did not reach the Linux login prompt or shell.");
  }
  if (!/Serial boot signal: RECEIVED/i.test(result.bootSignal) &&
      !/Linux shell detected/i.test(result.detail)) {
    throw new Error("Linux login UI appeared without a confirmed guest serial boot signal.");
  }

  console.log("PASS: QEMU loaded the OPFS disk and booted Alpine to its login prompt.");
  await context.close();
} catch (error) {
  console.error("FAIL:", error.stack || error.message);
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/boot-diagnostics.json", JSON.stringify({
    error: error.stack || error.message,
    consoleErrors,
    pageErrors,
    failedRequests
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
