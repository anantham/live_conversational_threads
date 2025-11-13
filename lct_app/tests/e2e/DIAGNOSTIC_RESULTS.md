# E2E Test Page Crash - Diagnostic Results

## Root Cause Identified

**THE ISSUE: WebGL is NOT available in Playwright's Chromium browser**

### Evidence

```
[TEST 2] Testing WebGL support...
[TEST 2] { hasWebGL1: false, hasWebGL2: false }

⚠️  LIMITED CANVAS/WEBGL SUPPORT
   This could cause ReactFlow to crash
```

### Timeline

1. Page loads successfully (all JS/CSS loads fine)
2. React renders components
3. ReactFlow components try to initialize
4. ReactFlow attempts to use WebGL for rendering
5. **WebGL context fails to create → Silent crash within ~1 second**

### Why No JavaScript Error?

WebGL/Canvas failures can cause **browser tab crashes** rather than JavaScript exceptions.
The crash happens at the browser rendering layer, not in JavaScript execution.

## Hypotheses Results

| Hypothesis | Status | Finding |
|------------|--------|---------|
| H1: ReactFlow | ✅ **ROOT CAUSE** | ReactFlow requires WebGL, not available in Playwright |
| H2: Router | ❌ Falsified | Router loads fine, minimal React works |
| H4: CSS/Tailwind | ❌ Falsified | CSS loads successfully |
| H5: Browser APIs | ❌ Falsified | No API calls before crash |
| H6: Network | ❌ Falsified | All requests succeed |
| H7: Component Interaction | ✅ Contributing | All ReactFlow components load at once |
| H8: StrictMode | ❓ Not tested | Unlikely given WebGL issue |

## Technical Details

**What Playwright shows:**
- Canvas 2D: ✅ Supported
- WebGL 1: ❌ **NOT supported**
- WebGL 2: ❌ **NOT supported**

**What ReactFlow needs:**
- Canvas or WebGL for graph rendering
- Falls back to Canvas 2D if WebGL unavailable
- But crash suggests the fallback isn't working properly

## Solutions

### Option 1: Enable GPU/WebGL in Playwright (Recommended)

Add to `playwright.config.ts`:

```typescript
use: {
  launchOptions: {
    args: [
      '--use-gl=swiftshader',  // Use SwiftShader for WebGL
      '--enable-webgl',
      '--enable-accelerated-2d-canvas',
    ],
  },
},
```

### Option 2: Use xvfb for virtual display (Linux)

```bash
xvfb-run npm run test:e2e
```

### Option 3: Mock ReactFlow for E2E tests

Create test-specific versions of pages that don't use ReactFlow.

### Option 4: Test only non-ReactFlow pages

Update tests to focus on pages without graph visualization:
- ✅ Home page
- ✅ Settings
- ✅ Cost Dashboard
- ❌ New Conversation (has ReactFlow)
- ❌ View Conversation (has ReactFlow)
- ❌ Browse (may have ReactFlow)

### Option 5: Use visual regression testing instead

Use Percy, Chromatic, or similar for ReactFlow pages.

## Recommended Next Steps

1. **Quick Fix**: Add SwiftShader WebGL args to playwright.config.ts
2. **Test**: Run diagnostic again to confirm WebGL now works
3. **Verify**: Run full test suite
4. **Document**: Update E2E-TESTING.md with WebGL requirements

## Additional Notes

- This is a common issue with Playwright + Canvas/WebGL libraries
- Headless browsers often lack GPU acceleration by default
- SwiftShader provides software-based WebGL implementation
- Alternative: Run tests in headed mode with display server (xvfb)

## Commands to Verify Fix

After applying solution:

```bash
# Should show WebGL support
npx playwright test diag-canvas --reporter=list

# Should pass without crashes
npx playwright test diag-summary --reporter=list

# Full test suite
npm run test:e2e
```
