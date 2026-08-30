# Mobile Layout Fixes for DevHub

**Date**: 2026-08-30  
**Issue**: [#44](https://github.com/dachrisch/devhub/issues/44)  
**Status**: Design Approved

## Problem Summary

Tested at narrow viewports (360-500px), the devhub board has several mobile usability issues:

1. **Header controls clip off-screen** - `.page-wrap` uses `overflow: hidden` and header is non-wrapping flex row, causing buttons to render past visible edge
2. **Board grid never stacks** - Hardcoded to 4 columns (960px+ minimum), forces horizontal scrolling
3. **Touch targets undersized** - Most interactive elements below WCAG 44×44px minimum
4. **Search min-width forces overflow** - `min-width: 220px` combined with other elements exceeds mobile width

## Proposed Solution

### 1. Header Mobile Behavior (≤768px breakpoint)

**Current**: Non-wrapping flex row with text labels  
**New**: Compact icon-based controls with wrap support

- Keep brand/logo on left
- Replace text controls with icons:
  - Search: magnifying glass → expands to full-width input on tap
  - Connection status: colored dot (green/red)
  - User: avatar only (no username text)
  - Refresh: circular arrow icon
  - Sign out: power/exit icon
- Add `flex-wrap: wrap` to header on mobile
- Change `.page-wrap` from `overflow: hidden` to `overflow: visible` on mobile

**CSS Changes**:
```css
@media (max-width: 768px) {
  .page-wrap {
    overflow: visible;
  }
  
  header {
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 16px;
  }
  
  .brand-name {
    display: none; /* Show only logo on mobile */
  }
  
  .search {
    min-width: 0;
    width: 100%;
    order: 10; /* Move search to bottom when wrapping */
  }
  
  .auth-login {
    display: none; /* Hide username text */
  }
  
  /* Icon-only buttons */
  .header-icon-btn {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
  }
}
```

### 2. Board Navigation - Swipeable Columns

**Current**: 4-column CSS grid  
**New**: Single column view with bottom tab bar and swipe navigation

**Bottom Navigation Bar**:
- Fixed at viewport bottom
- 4 tabs: Backlog, Developing, PR, Blocked
- Each tab shows icon + label + item count badge
- Active tab highlighted with accent color
- Height: 56px (standard mobile nav height)

**Swipeable Columns**:
- Only one column visible at a time
- Horizontal swipe to switch between columns
- CSS scroll-snap for smooth behavior
- Visual indicator (dots or tab highlight) shows current position

**Implementation Approach**:
- Use CSS `scroll-snap-type: x mandatory` on container
- Each column is `scroll-snap-align: start`
- Bottom bar tabs trigger `scrollIntoView()` with smooth behavior
- Track current column via Intersection Observer or scroll position

**CSS Changes**:
```css
@media (max-width: 768px) {
  .board {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 56px; /* Space for bottom nav */
    gap: 0;
  }
  
  .column {
    min-width: 100%;
    scroll-snap-align: start;
    flex-shrink: 0;
  }
}

.bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  .bottom-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    z-index: 100;
  }
  
  .bottom-nav-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 44px;
    color: var(--muted);
    font-size: 10px;
    text-transform: capitalize;
  }
  
  .bottom-nav-tab.active {
    color: var(--accent);
  }
  
  .bottom-nav-badge {
    background: var(--border);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
  }
}
```

### 3. Touch Target Improvements

**Current**: Small buttons/links (26-28px height)  
**New**: Minimum 44×44px tap targets

**Affected Elements**:
- `.develop-btn`: Increase padding to `12px 20px`
- `.recap-link`: Increase padding to `12px 16px`
- `.card-actions` buttons: Ensure 44px height
- All interactive elements in cards

**CSS Changes**:
```css
@media (max-width: 768px) {
  .develop-btn {
    padding: 12px 20px;
    min-height: 44px;
    font-size: 14px;
  }
  
  .recap-link {
    padding: 12px 16px;
    min-height: 44px;
  }
  
  .card {
    padding: 16px;
  }
  
  .card-actions {
    margin-top: 12px;
  }
}
```

### 4. Search Input Mobile Behavior

**Current**: `min-width: 220px`, always visible  
**New**: Expandable search on mobile

**Behavior**:
- On mobile, show only search icon in header
- Tap icon to expand search to full-width overlay
- Input takes full width with cancel button
- Dismiss on blur or cancel

**Implementation**:
- Add `expanded` state to control search visibility
- Use CSS transitions for smooth expand/collapse
- JavaScript to handle focus/blur events

## Files to Modify

1. **`src/app/globals.css`** - Add mobile breakpoint styles
2. **`src/app/(board)/page.tsx`** - Update header structure, add bottom nav, implement swipe logic

## Testing Plan

1. **Viewport Testing**: Test at 360px, 400px, 500px, 768px breakpoints
2. **Touch Testing**: Verify all controls are tappable (44×44px minimum)
3. **Swipe Testing**: Verify horizontal swipe works between columns
4. **Accessibility**: Ensure screen readers can navigate bottom tabs
5. **Performance**: Verify smooth 60fps swipe animations

## Success Criteria

- [ ] Header controls visible and usable at 360px viewport
- [ ] Board columns stack/swipe on mobile
- [ ] All interactive elements ≥44×44px touch targets
- [ ] No horizontal scrolling on page (only within board)
- [ ] Bottom navigation accessible and functional
- [ ] No regression on desktop layout

## Implementation Order

1. Add mobile CSS breakpoint and basic header fixes
2. Fix touch target sizes
3. Implement bottom navigation bar
4. Add swipeable column behavior
5. Implement expandable search
6. Test and refine
