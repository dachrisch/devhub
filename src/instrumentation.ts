export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recoverStuckDeveloping } = await import('./lib/store');
    const recovered = recoverStuckDeveloping();
    if (recovered > 0) {
      console.log(`[startup] Recovered ${recovered} stuck developing issue(s) — needs input (blocked_reason set)`);
    }

    // Register cockpit skills
    await import('./lib/skills/fix');
    await import('./lib/skills/launch');
  }
}
