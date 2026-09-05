'use client';

import { useEffect, useState } from 'react';

// How many pixels the on-screen keyboard overlaps the layout viewport bottom
// (0 = no keyboard). Chrome with `interactive-widget=resizes-content` already
// shrinks the layout viewport, so the overlap stays ~0 there; iOS Safari has
// no such option — the keyboard overlays a full-height layout viewport, which
// is exactly why bottom-anchored sheets become invisible while typing. This
// hook gives the sheet the offset it must lift by.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(overlap);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
