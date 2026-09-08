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
    await import('./lib/skills/create-issue');
    await import('./lib/skills/create-topic');
    await import('./lib/skills/suggest-feature');
    await import('./lib/skills/promote-topic');
    await import('./lib/skills/shape-idea');
    await import('./lib/skills/realize-idea');
  }
}
