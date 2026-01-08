# E2E Test Page Crash - Diagnostic Plan

## Problem Statement
Page loads initially (Vite connects, React DevTools loads) but crashes ~2 seconds later in Playwright browser environment.

## Falsifiable Hypotheses

### H1: ReactFlow Initialization Crash
**Hypothesis**: ReactFlow crashes when it tries to initialize without proper canvas context in Playwright's browser.

**Test to Falsify**: Create a minimal app that ONLY loads ReactFlow with basic setup.
- If crashes → H1 supported
- If works → H1 falsified

**Files**: `tests/e2e/diag-h1-reactflow.spec.ts`

---

### H2: React Router BrowserRouter Issue
**Hypothesis**: BrowserRouter has issues in Playwright's environment (URL handling, history API).

**Test to Falsify**: Create app without BrowserRouter (just render static content from App.jsx).
- If crashes → H2 falsified (not router)
- If works → H2 supported

**Files**: `tests/e2e/diag-h2-router.spec.ts` + `src/AppMinimal.jsx` (no router)

---

### H3: Specific Page Component Crash
**Hypothesis**: The Home component or one of its dependencies crashes on mount.

**Test to Falsify**: Test each page component in isolation:
- Home page only
- NewConversation page only
- Browse page only
- etc.

**Files**: `tests/e2e/diag-h3-components.spec.ts`

---

### H4: CSS/Tailwind Processing Issue
**Hypothesis**: Tailwind 4 or its Vite plugin causes issues in Playwright.

**Test to Falsify**: Create app with no Tailwind classes, just inline styles.
- If crashes → H4 falsified
- If works → H4 supported

**Files**: `tests/e2e/diag-h4-css.spec.ts` + `src/AppNoCSS.jsx`

---

### H5: Browser API Access Crash
**Hypothesis**: Code accesses browser APIs (localStorage, window methods, etc.) that crash in Playwright.

**Test to Falsify**:
1. Mock all storage APIs before page load
2. Check for window.* access patterns
3. Run with browser console capturing all API calls

**Files**: `tests/e2e/diag-h5-browser-apis.spec.ts`

---

### H6: Async API Call Failure
**Hypothesis**: Component makes API calls on mount that fail and crash the page.

**Test to Falsify**:
1. Mock/intercept all network requests
2. Block all network requests
3. Check if crash still happens

**Files**: `tests/e2e/diag-h6-network.spec.ts`

---

### H7: Multiple Component Interaction
**Hypothesis**: Crash only happens when multiple components are mounted together (not in isolation).

**Test to Falsify**: Mount components one by one, incrementally.
- Start with just root div
- Add Router
- Add Home component
- Add ReactFlow components
- etc.

**Files**: `tests/e2e/diag-h7-incremental.spec.ts`

---

### H8: React StrictMode Double-Render Issue
**Hypothesis**: React.StrictMode causes double-mount that triggers a crash in Playwright.

**Test to Falsify**: Remove StrictMode from main.jsx temporarily.
- If crashes → H8 falsified
- If works → H8 supported

**Files**: `tests/e2e/diag-h8-strictmode.spec.ts` + `src/main-no-strict.jsx`

---

## Diagnostic Test Order

Run in this order for maximum information gain:

1. **H2 (Router)** - Quick to test, high impact if true
2. **H8 (StrictMode)** - Very quick to test
3. **H5 (Browser APIs)** - Can capture detailed logs
4. **H4 (CSS/Tailwind)** - Medium effort, common issue
5. **H1 (ReactFlow)** - Known to be complex, likely candidate
6. **H6 (Network)** - Easy to test with Playwright
7. **H3 (Components)** - Test specific pages
8. **H7 (Interaction)** - Most time-consuming, do last

## Success Criteria

For each test:
- **Pass**: Page loads and stays stable for 10+ seconds without crash
- **Fail**: Page crashes (we see "[PAGE CRASHED]" message)

## Next Steps

After identifying which hypothesis is supported:
1. Document the root cause
2. Design minimal, targeted fix
3. Re-run original test suite to verify fix
