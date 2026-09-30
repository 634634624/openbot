import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack refuses a request older than this, and so does the host: it stops a replay. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Checks Slack's `v0` request signature: HMAC-SHA256 of `v0:<timestamp>:<body>` with the app's
 * signing secret. Signal passes the request on without checking it, because only the host has the
 * secret, so this is the check that decides whether a request came from Slack.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  body: Uint8Array;
  nowSeconds?: number;
}): boolean {
  if (!/^[0-9]{1,12}$/.test(input.timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (Math.abs(now - Number(input.timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:`).update(input.body).digest("hex")}`,
  );
  const actual = Buffer.from(input.signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
