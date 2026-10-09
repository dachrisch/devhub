export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recoverStuckDeveloping } = await import('./lib/store');
    const recovered = recoverStuckDeveloping();
    if (recovered > 0) {
      console.log(`[startup] Recovered ${recovered} stuck developing issue(s) — needs input (blocked_reason set)`);
    }
    // Collect the opencode /event stream into activity_event (persist-only).
    // Best-effort and idempotent across HMR; it retries if opencode is down.
    const { ensureOpencodeEventSubscription } = await import('./lib/activity/sources/opencode-api');
    ensureOpencodeEventSubscription();
  }
}
