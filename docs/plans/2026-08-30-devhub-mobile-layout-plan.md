# Mobile Layout Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix mobile layout issues in DevHub to make the board usable on narrow viewports (360-500px) by adding responsive CSS, bottom navigation, and swipeable columns.

**Architecture:** Add a mobile breakpoint (≤768px) that transforms the header to icon-based controls, replaces the 4-column grid with swipeable single-column view, adds fixed bottom navigation bar, and increases touch targets to WCAG 44×44px minimum.

**Tech Stack:** CSS Grid/Flexbox, CSS Scroll Snap, vanilla JavaScript for swipe detection, React state for navigation.

---

### Task 1: Add Mobile CSS Breakpoint Foundation

**Files:**
- Modify: `src/app/globals.css:1-693` (add media queries at end of file)

**Step 1: Add basic mobile breakpoint structure**

```css
/* Mobile breakpoint */
@media (max-width: 768px) {
  /* Task 1: Foundation */
  .page-wrap {
    overflow: visible;
  }
}
```

**Step 2: Verify CSS loads without errors**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "style: add mobile breakpoint foundation"
```

---

### Task 2: Fix Header Overflow on Mobile

**Files:**
- Modify: `src/app/globals.css` (add header styles to mobile breakpoint)
- Modify: `src/app/(board)/page.tsx:158-184` (update header structure)

**Step 1: Add header mobile styles**

```css
@media (max-width: 768px) {
  /* ... existing Task 1 styles ... */
  
  header {
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 16px;
  }
  
  .brand-name {
    display: none;
  }
  
  .auth-login {
    display: none;
  }
}
```

**Step 2: Update header JSX to add icon classes**

In `src/app/(board)/page.tsx`, modify the header section (lines 163-183):

```tsx
<div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
  <input
    className="search"
    placeholder="Search…  e.g. repo:web title:auth or free text"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
  />
  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
    {connected ? 'live' : 'connecting…'}
  </span>
  {user && (
    <>
      <Avatar login={user.login} avatarUrl={user.avatarUrl} />
      <span className="auth-login">{user.login}</span>
      <button className="header-icon-btn" onClick={logout} aria-label="Sign out">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5H6.75a.75.75 0 000 1.5h5.69l-1.97 1.97a.75.75 0 101.06 1.06l3.25-3.25a.75.75 0 000-1.06l-3.25-3.25a.75.75 0 10-1.06 1.06l1.97 1.97z"/>
        </svg>
      </button>
    </>
  )}
  <button className="header-icon-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh issues">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'spin' : ''}>
      <path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 01-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/>
    </svg>
  </button>
</div>
```

**Step 3: Add icon button styles**

```css
@media (max-width: 768px) {
  /* ... existing styles ... */
  
  .header-icon-btn {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
  }
  
  .header-icon-btn:hover {
    background: var(--panel-2);
    border-radius: 6px;
  }
  
  .header-icon-btn:disabled {
    opacity: 0.5;
  }
  
  .spin {
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
}
```

**Step 4: Verify header wraps on mobile**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "fix: header wraps on mobile with icon controls"
```

---

### Task 3: Increase Touch Target Sizes

**Files:**
- Modify: `src/app/globals.css` (add touch target styles to mobile breakpoint)

**Step 1: Add touch target styles**

```css
@media (max-width: 768px) {
  /* ... existing styles ... */
  
  .develop-btn {
    padding: 12px 20px;
    min-height: 44px;
    font-size: 14px;
  }
  
  .recap-link {
    padding: 12px 16px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
  
  .card {
    padding: 16px;
  }
  
  .card-actions {
    margin-top: 12px;
  }
  
  button {
    min-height: 44px;
  }
}
```

**Step 2: Verify touch targets meet WCAG minimum**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "fix: increase touch targets to 44px minimum on mobile"
```

---

### Task 4: Add Bottom Navigation Bar

**Files:**
- Modify: `src/app/globals.css` (add bottom nav styles)
- Modify: `src/app/(board)/page.tsx` (add bottom nav component)

**Step 1: Add bottom nav CSS**

```css
/* Bottom navigation - hidden on desktop */
.bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  /* ... existing styles ... */
  
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
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  
  .bottom-nav-tab:hover {
    color: var(--text);
  }
  
  .bottom-nav-tab.active {
    color: var(--accent);
  }
  
  .bottom-nav-icon {
    width: 20px;
    height: 20px;
  }
  
  .bottom-nav-badge {
    background: var(--border);
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
  }
  
  .bottom-nav-tab.active .bottom-nav-badge {
    background: var(--accent);
    color: var(--bg);
  }
}
```

**Step 2: Add bottom nav component to page**

In `src/app/(board)/page.tsx`, add state for active column and bottom nav JSX:

```tsx
// Add state for active column (after line 89)
const [activeColumn, setActiveColumn] = useState<IssueState>('backlog');

// Add bottom nav before closing </div> of page-wrap (after line 204)
<nav className="bottom-nav" role="tablist" aria-label="Board columns">
  {COLUMNS.map((col) => {
    const count = issues.filter((i) => i.state === col).length;
    return (
      <button
        key={col}
        className={`bottom-nav-tab${activeColumn === col ? ' active' : ''}`}
        onClick={() => setActiveColumn(col)}
        role="tab"
        aria-selected={activeColumn === col}
        aria-label={`${col} column, ${count} items`}
      >
        <span className={`dot ${col}`} />
        <span>{col}</span>
        <span className="bottom-nav-badge">{count}</span>
      </button>
    );
  })}
</nav>
```

**Step 3: Verify bottom nav renders**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: add bottom navigation bar for mobile"
```

---

### Task 5: Implement Swipeable Columns

**Files:**
- Modify: `src/app/globals.css` (add swipeable styles)
- Modify: `src/app/(board)/page.tsx` (add swipe logic and scroll behavior)

**Step 1: Add swipeable column CSS**

```css
@media (max-width: 768px) {
  /* ... existing styles ... */
  
  .board {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 56px;
    gap: 0;
    scroll-behavior: smooth;
  }
  
  .column {
    min-width: 100%;
    scroll-snap-align: start;
    flex-shrink: 0;
    background: transparent;
    border: none;
    border-radius: 0;
  }
  
  .column-head {
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
}
```

**Step 2: Add swipe detection and scroll-to-column logic**

In `src/app/(board)/page.tsx`, add refs and scroll logic:

```tsx
// Add refs (after line 89)
const boardRef = useRef<HTMLDivElement>(null);
const columnRefs = useRef<Map<IssueState, HTMLDivElement>>(new Map());

// Add scroll-to-column function
const scrollToColumn = useCallback((col: IssueState) => {
  const el = columnRefs.current.get(col);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }
}, []);

// Update column rendering to add refs (modify lines 187-203)
<div className="board" ref={boardRef}>
  {COLUMNS.map((col) => {
    const items = issues.filter((i) => i.state === col && matchesIssue(i, query));
    return (
      <section 
        className="column" 
        key={col}
        ref={(el) => {
          if (el) columnRefs.current.set(col, el);
        }}
      >
        <div className="column-head">
          <span className={`dot ${col}`} />
          {col}
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
        </div>
        {items.length === 0 ? (
          <div className="empty">nothing here</div>
        ) : (
          items.map((issue) => <Card key={issue.id} issue={issue} />)
        )}
      </section>
    );
  })}
</div>

// Update bottom nav onClick to scroll (modify line in Task 4)
onClick={() => {
  setActiveColumn(col);
  scrollToColumn(col);
}}
```

**Step 3: Add Intersection Observer to track current column**

```tsx
// Add useEffect for Intersection Observer (after line 131)
useEffect(() => {
  if (typeof window === 'undefined') return;
  
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          // Find which column this element represents
          for (const [col, el] of columnRefs.current.entries()) {
            if (el === entry.target) {
              setActiveColumn(col);
              break;
            }
          }
        }
      });
    },
    { root: boardRef.current, threshold: 0.5 }
  );
  
  // Observe all columns
  columnRefs.current.forEach((el) => observer.observe(el));
  
  return () => observer.disconnect();
}, [signedIn]);
```

**Step 4: Verify swipe works on mobile**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: implement swipeable columns with scroll snap"
```

---

### Task 6: Implement Expandable Search on Mobile

**Files:**
- Modify: `src/app/globals.css` (add expandable search styles)
- Modify: `src/app/(board)/page.tsx` (add search expand logic)

**Step 1: Add expandable search CSS**

```css
@media (max-width: 768px) {
  /* ... existing styles ... */
  
  .search-wrapper {
    position: relative;
    width: 44px;
    height: 44px;
  }
  
  .search-toggle {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    border-radius: 6px;
  }
  
  .search-toggle:hover {
    background: var(--panel-2);
  }
  
  .search {
    position: absolute;
    top: 0;
    left: 0;
    width: calc(100vw - 32px);
    max-width: none;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
    z-index: 20;
  }
  
  .search.expanded {
    opacity: 1;
    pointer-events: auto;
  }
  
  .search-cancel {
    position: absolute;
    right: -60px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--accent);
    background: transparent;
    border: none;
    font-size: 14px;
    cursor: pointer;
  }
}
```

**Step 2: Add search expand logic**

In `src/app/(board)/page.tsx`, add state and update search:

```tsx
// Add state (after line 89)
const [searchExpanded, setSearchExpanded] = useState(false);

// Update search section in header (lines 164-169)
<div className="search-wrapper">
  <button 
    className="search-toggle" 
    onClick={() => setSearchExpanded(true)}
    aria-label="Open search"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/>
    </svg>
  </button>
  <input
    className={`search${searchExpanded ? ' expanded' : ''}`}
    placeholder="Search…  e.g. repo:web title:auth or free text"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    onBlur={() => {
      if (!query) setSearchExpanded(false);
    }}
  />
  {searchExpanded && (
    <button 
      className="search-cancel" 
      onClick={() => {
        setSearchExpanded(false);
        setQuery('');
      }}
    >
      Cancel
    </button>
  )}
</div>
```

**Step 3: Verify search expands on mobile**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: implement expandable search on mobile"
```

---

### Task 7: Final Testing and Polish

**Files:**
- None (testing and verification only)

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run type checking**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run linting**

Run: `npm run lint`
Expected: PASS

**Step 4: Build production bundle**

Run: `npm run build`
Expected: PASS

**Step 5: Manual testing checklist**

Test at these viewports:
- [ ] 360px (small phone)
- [ ] 400px (standard phone)
- [ ] 500px (large phone)
- [ ] 768px (tablet breakpoint)
- [ ] 1024px+ (desktop - no regression)

Verify:
- [ ] Header controls visible and tappable
- [ ] Bottom navigation works
- [ ] Columns swipe horizontally
- [ ] Touch targets ≥44×44px
- [ ] No horizontal page scroll
- [ ] Search expands on mobile
- [ ] All buttons functional

**Step 6: Final commit (if any polish needed)**

```bash
git add -A
git commit -m "fix: polish mobile layout and responsive design"
```

---

## Summary

**Total Tasks**: 7  
**Estimated Time**: 45-60 minutes  
**Files Modified**: 2 (`globals.css`, `page.tsx`)

**Key Features**:
1. Mobile breakpoint with header icon controls
2. Increased touch targets (44×44px minimum)
3. Fixed bottom navigation bar
4. Swipeable columns with scroll snap
5. Expandable search on mobile

**Testing**:
- Type checking: `npm run typecheck`
- Linting: `npm run lint`
- Tests: `npm test`
- Build: `npm run build`
- Manual viewport testing at 360px, 400px, 500px, 768px, 1024px+
