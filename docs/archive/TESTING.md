# Testing Documentation

## Current Test Coverage: 0%

⚠️ **CRITICAL**: This project currently has **ZERO automated tests**.

This document outlines the current testing state, recommended testing strategy, and implementation roadmap for achieving comprehensive test coverage.

---

## Table of Contents
- [Current State](#current-state)
- [Testing Requirements](#testing-requirements)
- [Testing Strategy](#testing-strategy)
- [Backend Testing](#backend-testing)
- [Frontend Testing](#frontend-testing)
- [End-to-End Testing](#end-to-end-testing)
- [Implementation Roadmap](#implementation-roadmap)
- [Testing Tools](#testing-tools)
- [Coverage Goals](#coverage-goals)
- [CI/CD Integration](#cicd-integration)

---

## Current State

### What We Have
- **Unit Tests**: 0
- **Integration Tests**: 0
- **Component Tests**: 0
- **End-to-End Tests**: 0
- **API Tests**: 0
- **WebSocket Tests**: 0
- **Database Tests**: 0

### Testing Infrastructure
- ❌ No test framework configured
- ❌ No test files exist
- ❌ No coverage reporting
- ❌ No CI/CD test pipeline
- ❌ No mocking utilities
- ❌ No test database setup

### Risk Assessment
Without tests, the codebase is at **HIGH RISK** for:
- Regression bugs when making changes
- Breaking existing functionality during refactoring
- Undetected edge case failures
- Database integrity issues
- API contract violations
- WebSocket connection failures
- Integration problems between frontend and backend

---

## Testing Requirements

### Critical Areas Requiring Coverage

#### Backend (Priority: CRITICAL)
- [ ] **API Endpoints** (~2000 LOC in backend.py)
  - POST `/get_chunks/` - Transcript chunking
  - POST `/generate-context-stream/` - Streaming conversation analysis
  - POST `/save_json/` - Save conversation to GCS/DB
  - POST `/generate_formalism/` - Formalism generation
  - GET `/conversations/` - List conversations
  - GET `/conversations/{id}` - Get specific conversation
  - POST `/fact_check_claims/` - Fact checking
  - WebSocket `/ws/audio` - Real-time transcription

#### Database Operations (Priority: HIGH)
- [ ] `insert_conversation_metadata()` - Insert/update conversations
- [ ] `get_all_conversations()` - Query all conversations
- [ ] `get_conversation_gcs_path()` - Retrieve GCS path
- [ ] Database connection lifecycle
- [ ] Transaction rollback behavior

#### Frontend Components (Priority: MEDIUM)
- [ ] `AudioInput.jsx` - Audio recording and WebSocket
- [ ] `Input.jsx` - Text input handling
- [ ] `ContextualGraph.jsx` - Graph visualization
- [ ] `StructuralGraph.jsx` - Formalism display
- [ ] `SaveJson.jsx` - Save functionality
- [ ] `NewConversation.jsx` - Main page logic
- [ ] `Browse.jsx` - List display
- [ ] `ViewConversation.jsx` - Conversation viewing

#### Integration Points (Priority: HIGH)
- [ ] Frontend → Backend API communication
- [ ] Backend → Database operations
- [ ] Backend → GCS file upload/retrieval
- [ ] Backend → AI service integrations
- [ ] WebSocket audio streaming pipeline

---

## Testing Strategy

### Testing Pyramid

```
                    ┌─────────────────┐
                    │   E2E Tests     │  10% (User flows)
                    │    ~20 tests    │
                    └─────────────────┘
                   ┌───────────────────┐
                   │ Integration Tests │  30% (Component integration)
                   │    ~80 tests      │
                   └───────────────────┘
              ┌──────────────────────────┐
              │     Unit Tests           │  60% (Individual functions)
              │     ~200 tests           │
              └──────────────────────────┘
```

### Test Coverage Goals

| Component | Target Coverage | Priority |
|-----------|----------------|----------|
| Backend API endpoints | 90%+ | CRITICAL |
| Database helpers | 95%+ | HIGH |
| Frontend components | 80%+ | MEDIUM |
| Utility functions | 90%+ | HIGH |
| Integration tests | 70%+ | HIGH |
| E2E critical paths | 100% | CRITICAL |

---

## Backend Testing

### Setup

**Install testing dependencies:**
```bash
pip install pytest pytest-asyncio pytest-cov httpx faker
```

Add to `lct_python_backend/requirements-dev.txt`:
```
pytest==8.0.0
pytest-asyncio==0.23.0
pytest-cov==4.1.0
httpx==0.26.0
faker==22.0.0
pytest-mock==3.12.0
```

### Test Structure

```
lct_python_backend/
├── tests/
│   ├── __init__.py
│   ├── conftest.py              # Pytest configuration & fixtures
│   ├── test_api/
│   │   ├── __init__.py
│   │   ├── test_chunks.py       # Test /get_chunks/
│   │   ├── test_context.py      # Test /generate-context-stream/
│   │   ├── test_save.py         # Test /save_json/
│   │   ├── test_formalism.py    # Test /generate_formalism/
│   │   ├── test_conversations.py # Test conversation endpoints
│   │   └── test_websocket.py    # Test WebSocket audio
│   ├── test_database/
│   │   ├── __init__.py
│   │   ├── test_db_helpers.py   # Test database operations
│   │   └── test_connection.py   # Test DB connection lifecycle
│   ├── test_integration/
│   │   ├── __init__.py
│   │   ├── test_gcs_integration.py
│   │   └── test_ai_services.py
│   └── fixtures/
│       ├── sample_transcripts.json
│       └── mock_responses.json
```

### Example Test: API Endpoint

**File: `tests/test_api/test_chunks.py`**
```python
import pytest
from httpx import AsyncClient
from lct_python_backend.backend import lct_app

@pytest.mark.asyncio
async def test_get_chunks_success():
    """Test transcript chunking with valid input"""
    async with AsyncClient(app=lct_app, base_url="http://test") as client:
        response = await client.post(
            "/get_chunks/",
            json={"transcript": "This is a test transcript. " * 1000}
        )

    assert response.status_code == 200
    data = response.json()
    assert "chunks" in data
    assert isinstance(data["chunks"], dict)
    assert len(data["chunks"]) > 0

@pytest.mark.asyncio
async def test_get_chunks_empty_transcript():
    """Test chunking with empty transcript"""
    async with AsyncClient(app=lct_app, base_url="http://test") as client:
        response = await client.post(
            "/get_chunks/",
            json={"transcript": ""}
        )

    assert response.status_code in [200, 400]  # Define expected behavior

@pytest.mark.asyncio
async def test_get_chunks_large_transcript():
    """Test chunking with very large transcript"""
    large_transcript = "Word " * 50000  # ~50k words

    async with AsyncClient(app=lct_app, base_url="http://test") as client:
        response = await client.post(
            "/get_chunks/",
            json={"transcript": large_transcript}
        )

    assert response.status_code == 200
    data = response.json()
    # Verify chunking occurred
    assert len(data["chunks"]) >= 3
```

### Example Test: Database Operations

**File: `tests/test_database/test_db_helpers.py`**
```python
import pytest
from datetime import datetime
from lct_python_backend.db_helpers import (
    insert_conversation_metadata,
    get_all_conversations,
    get_conversation_gcs_path
)

@pytest.mark.asyncio
async def test_insert_conversation_metadata(test_db):
    """Test inserting conversation metadata"""
    metadata = {
        "id": "test-conv-123",
        "file_name": "test_conversation.json",
        "no_of_nodes": 10,
        "gcs_path": "gs://bucket/test.json",
        "created_at": datetime.utcnow()
    }

    await insert_conversation_metadata(metadata)

    # Verify insertion
    result = await get_conversation_gcs_path("test-conv-123")
    assert result == "gs://bucket/test.json"

@pytest.mark.asyncio
async def test_get_all_conversations_empty(test_db):
    """Test retrieving conversations when database is empty"""
    conversations = await get_all_conversations()
    assert conversations == []

@pytest.mark.asyncio
async def test_get_all_conversations_ordering(test_db, sample_conversations):
    """Test conversations are ordered by created_at DESC"""
    conversations = await get_all_conversations()

    assert len(conversations) >= 2
    # Check descending order
    for i in range(len(conversations) - 1):
        assert conversations[i]["created_at"] >= conversations[i+1]["created_at"]
```

### Test Fixtures

**File: `tests/conftest.py`**
```python
import pytest
import asyncio
from databases import Database

@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for async tests"""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.fixture
async def test_db():
    """Create test database connection"""
    database = Database("postgresql://test_user:test_pass@localhost/test_lct")
    await database.connect()

    # Create test tables
    await database.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            file_name TEXT,
            no_of_nodes INTEGER,
            gcs_path TEXT,
            created_at TIMESTAMP
        )
    """)

    yield database

    # Cleanup
    await database.execute("DROP TABLE conversations")
    await database.disconnect()

@pytest.fixture
def sample_transcript():
    """Sample transcript for testing"""
    return "This is a sample conversation about AI and machine learning. " * 100

@pytest.fixture
def mock_anthropic_response():
    """Mock response from Anthropic API"""
    return {
        "content": [{"text": '{"nodes": [], "edges": []}'}]
    }
```

### Running Backend Tests

```bash
# Run all tests
pytest lct_python_backend/tests/

# Run with coverage
pytest --cov=lct_python_backend --cov-report=html lct_python_backend/tests/

# Run specific test file
pytest lct_python_backend/tests/test_api/test_chunks.py

# Run tests matching pattern
pytest -k "test_chunks"

# Run with verbose output
pytest -v lct_python_backend/tests/
```

---

## Frontend Testing

### Setup

**Install testing dependencies:**
```bash
cd lct_app
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Update `lct_app/package.json`:
```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage"
  },
  "devDependencies": {
    "vitest": "^1.2.0",
    "@testing-library/react": "^14.1.2",
    "@testing-library/jest-dom": "^6.1.5",
    "@testing-library/user-event": "^14.5.1",
    "@vitest/ui": "^1.2.0",
    "jsdom": "^23.2.0"
  }
}
```

### Test Structure

```
lct_app/
├── src/
│   ├── __tests__/
│   │   ├── components/
│   │   │   ├── AudioInput.test.jsx
│   │   │   ├── Input.test.jsx
│   │   │   ├── ContextualGraph.test.jsx
│   │   │   ├── SaveJson.test.jsx
│   │   │   └── Legend.test.jsx
│   │   ├── pages/
│   │   │   ├── Home.test.jsx
│   │   │   ├── NewConversation.test.jsx
│   │   │   ├── Browse.test.jsx
│   │   │   └── ViewConversation.test.jsx
│   │   └── utils/
│   │       └── SaveConversation.test.jsx
│   └── test-utils/
│       ├── setup.js
│       └── test-helpers.jsx
└── vitest.config.js
```

### Vitest Configuration

**File: `lct_app/vitest.config.js`**
```javascript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-utils/setup.js',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test-utils/',
        '**/*.config.js'
      ]
    }
  }
})
```

### Example Test: Component

**File: `src/__tests__/components/Input.test.jsx`**
```javascript
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Input from '../../components/Input'

describe('Input Component', () => {
  it('renders input textarea', () => {
    render(<Input onDataReceived={vi.fn()} onChunksReceived={vi.fn()} />)

    const textarea = screen.getByPlaceholderText(/enter your transcript/i)
    expect(textarea).toBeInTheDocument()
  })

  it('calls onDataReceived when submit is clicked with valid input', async () => {
    const mockOnDataReceived = vi.fn()
    const mockOnChunksReceived = vi.fn()

    render(
      <Input
        onDataReceived={mockOnDataReceived}
        onChunksReceived={mockOnChunksReceived}
      />
    )

    const textarea = screen.getByPlaceholderText(/enter your transcript/i)
    const submitButton = screen.getByText(/submit/i)

    fireEvent.change(textarea, {
      target: { value: 'Test transcript content' }
    })

    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(mockOnChunksReceived).toHaveBeenCalled()
    })
  })

  it('shows error for empty input', () => {
    render(<Input onDataReceived={vi.fn()} onChunksReceived={vi.fn()} />)

    const submitButton = screen.getByText(/submit/i)
    fireEvent.click(submitButton)

    // Verify error handling
    // Add assertion based on actual error handling implementation
  })
})
```

### Example Test: Page Component

**File: `src/__tests__/pages/Browse.test.jsx`**
```javascript
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Browse from '../../pages/Browse'

// Mock fetch
global.fetch = vi.fn()

const renderWithRouter = (component) => {
  return render(<BrowserRouter>{component}</BrowserRouter>)
}

describe('Browse Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches and displays conversations', async () => {
    const mockConversations = [
      {
        id: 'conv-1',
        file_name: 'Test Conversation',
        no_of_nodes: 10,
        created_at: '2025-01-01T00:00:00Z'
      }
    ]

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockConversations
    })

    renderWithRouter(<Browse />)

    await waitFor(() => {
      expect(screen.getByText('Test Conversation')).toBeInTheDocument()
    })
  })

  it('displays loading state initially', () => {
    global.fetch.mockImplementation(() => new Promise(() => {}))

    renderWithRouter(<Browse />)

    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('handles fetch errors gracefully', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'))

    renderWithRouter(<Browse />)

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument()
    })
  })
})
```

### Running Frontend Tests

```bash
# Run all tests
npm test

# Run with UI
npm run test:ui

# Run with coverage
npm run test:coverage

# Watch mode
npm test -- --watch

# Run specific test file
npm test -- Input.test.jsx
```

---

## End-to-End Testing

### Setup with Playwright

**Install Playwright:**
```bash
npm install -D @playwright/test
npx playwright install
```

### Test Structure

```
lct_app/
├── e2e/
│   ├── fixtures/
│   │   └── test-data.json
│   ├── tests/
│   │   ├── conversation-flow.spec.js
│   │   ├── audio-recording.spec.js
│   │   ├── browse-conversations.spec.js
│   │   └── save-conversation.spec.js
│   └── playwright.config.js
```

### Example E2E Test

**File: `e2e/tests/conversation-flow.spec.js`**
```javascript
import { test, expect } from '@playwright/test'

test.describe('Conversation Creation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
  })

  test('should create new conversation with text input', async ({ page }) => {
    // Navigate to new conversation
    await page.click('text=New Conversation')
    await expect(page).toHaveURL(/.*\/new/)

    // Switch to text input mode
    await page.click('text=Text Input')

    // Enter transcript
    await page.fill('textarea', 'This is a test conversation about AI.')

    // Submit
    await page.click('button:has-text("Submit")')

    // Wait for graph to render
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10000 })

    // Verify nodes are created
    const nodes = await page.locator('.react-flow__node').count()
    expect(nodes).toBeGreaterThan(0)
  })

  test('should save conversation successfully', async ({ page }) => {
    // Create conversation (abbreviated)
    await page.goto('http://localhost:5173/new')
    await page.fill('textarea', 'Test conversation')
    await page.click('button:has-text("Submit")')

    // Wait for processing
    await page.waitForSelector('.react-flow__node')

    // Save conversation
    await page.fill('input[placeholder*="name"]', 'E2E Test Conversation')
    await page.click('button:has-text("Save")')

    // Verify success message
    await expect(page.locator('text=saved successfully')).toBeVisible()
  })

  test('should browse and view saved conversations', async ({ page }) => {
    // Navigate to browse
    await page.goto('http://localhost:5173/browse')

    // Wait for conversations to load
    await page.waitForSelector('text=Conversations', { timeout: 5000 })

    // Click first conversation
    const firstConv = page.locator('.conversation-item').first()
    await firstConv.click()

    // Verify redirected to view page
    await expect(page).toHaveURL(/.*\/conversation\/.*/)

    // Verify graph is displayed
    await expect(page.locator('.react-flow')).toBeVisible()
  })
})
```

### Running E2E Tests

```bash
# Run all E2E tests
npx playwright test

# Run with UI
npx playwright test --ui

# Run specific test
npx playwright test conversation-flow.spec.js

# Debug mode
npx playwright test --debug

# Generate test report
npx playwright show-report
```

---

## Implementation Roadmap

### Phase 1: Critical Backend Tests (Weeks 1-2)
- [ ] Set up pytest infrastructure
- [ ] Create test database
- [ ] Test all API endpoints (8 endpoints)
- [ ] Test database operations (3 functions)
- [ ] Mock external services (AI APIs, GCS)
- **Target**: 70% backend coverage

### Phase 2: Frontend Component Tests (Weeks 3-4)
- [ ] Set up Vitest infrastructure
- [ ] Test utility components (Input, SaveJson, Legend)
- [ ] Test graph components (ContextualGraph, StructuralGraph)
- [ ] Test page components (Home, Browse, ViewConversation)
- **Target**: 60% frontend coverage

### Phase 3: Integration Tests (Week 5)
- [ ] Frontend → Backend API integration
- [ ] WebSocket audio streaming
- [ ] GCS file operations
- [ ] End-to-end conversation flow
- **Target**: 70% integration coverage

### Phase 4: E2E Tests (Week 6)
- [ ] Set up Playwright
- [ ] Critical user flows (create, save, browse, view)
- [ ] Audio recording flow
- [ ] Formalism generation flow
- **Target**: 100% critical path coverage

### Phase 5: CI/CD & Automation (Week 7)
- [ ] GitHub Actions workflow
- [ ] Automated test runs on PR
- [ ] Coverage reporting
- [ ] Pre-commit hooks
- **Target**: Fully automated testing pipeline

---

## Testing Tools

### Backend
```bash
pytest==8.0.0                    # Test framework
pytest-asyncio==0.23.0           # Async test support
pytest-cov==4.1.0                # Coverage reporting
httpx==0.26.0                    # HTTP client for FastAPI tests
faker==22.0.0                    # Generate fake data
pytest-mock==3.12.0              # Mocking utilities
```

### Frontend
```bash
vitest                           # Test framework
@testing-library/react           # React component testing
@testing-library/jest-dom        # DOM matchers
@testing-library/user-event      # User interaction simulation
jsdom                            # DOM environment
@vitest/ui                       # Test UI
```

### E2E
```bash
@playwright/test                 # E2E testing framework
```

---

## Coverage Goals

### Overall Project Goal: 80%+ Coverage

| Component | Current | Target | Priority |
|-----------|---------|--------|----------|
| **Backend** | 0% | 85% | CRITICAL |
| - API Endpoints | 0% | 90% | CRITICAL |
| - Database Helpers | 0% | 95% | HIGH |
| - Utilities | 0% | 85% | MEDIUM |
| **Frontend** | 0% | 75% | HIGH |
| - Components | 0% | 80% | HIGH |
| - Pages | 0% | 70% | MEDIUM |
| - Utils | 0% | 90% | HIGH |
| **Integration** | 0% | 70% | HIGH |
| **E2E** | 0% | 100%* | CRITICAL |

*100% of critical user paths

### Coverage Measurement

```bash
# Backend coverage
pytest --cov=lct_python_backend --cov-report=term-missing

# Frontend coverage
npm run test:coverage

# View HTML reports
# Backend: htmlcov/index.html
# Frontend: coverage/index.html
```

---

## CI/CD Integration

### GitHub Actions Workflow

**File: `.github/workflows/test.yml`**
```yaml
name: Test Suite

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  backend-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: test_password
          POSTGRES_DB: test_lct
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.10'

      - name: Install dependencies
        run: |
          pip install -r lct_python_backend/requirements.txt
          pip install pytest pytest-asyncio pytest-cov

      - name: Run tests
        env:
          DATABASE_URL: postgresql://postgres:test_password@localhost/test_lct
        run: |
          pytest --cov=lct_python_backend --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage.xml

  frontend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install dependencies
        working-directory: ./lct_app
        run: npm ci

      - name: Run tests
        working-directory: ./lct_app
        run: npm run test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./lct_app/coverage/coverage-final.json

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install dependencies
        working-directory: ./lct_app
        run: |
          npm ci
          npx playwright install --with-deps

      - name: Start backend
        run: |
          # Start backend in background
          # Add actual startup commands

      - name: Start frontend
        working-directory: ./lct_app
        run: npm run dev &

      - name: Run E2E tests
        working-directory: ./lct_app
        run: npx playwright test

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: lct_app/playwright-report/
```

---

## Best Practices

### Writing Effective Tests

1. **Follow AAA Pattern**
   ```python
   # Arrange - Set up test data
   transcript = "Test content"

   # Act - Execute the code under test
   result = chunk_transcript(transcript)

   # Assert - Verify results
   assert len(result) > 0
   ```

2. **Test Edge Cases**
   - Empty inputs
   - Very large inputs
   - Invalid data types
   - Boundary conditions

3. **Use Descriptive Names**
   ```python
   # Good
   def test_chunk_transcript_with_empty_string_returns_empty_dict():
       pass

   # Bad
   def test_chunk():
       pass
   ```

4. **Keep Tests Isolated**
   - Each test should be independent
   - Use fixtures for setup/teardown
   - Don't rely on test execution order

5. **Mock External Dependencies**
   - AI service API calls
   - GCS operations
   - Database connections (in unit tests)

---

## Metrics & Monitoring

### Track These Metrics

- **Coverage %**: Aim for 80%+
- **Test Count**: Target ~300 tests total
- **Test Duration**: Keep under 5 minutes for full suite
- **Flaky Tests**: Should be 0%
- **Bug Escape Rate**: Tests should catch 95%+ of bugs before production

### Coverage Reports

Generate and review coverage reports regularly:

```bash
# Backend
pytest --cov=lct_python_backend --cov-report=html
open htmlcov/index.html

# Frontend
npm run test:coverage
open coverage/index.html
```

---

## Next Steps

### Immediate Actions (This Week)
1. Set up pytest infrastructure
2. Write first API endpoint test
3. Configure test database
4. Set up Vitest for frontend

### Short Term (This Month)
1. Complete Phase 1 & 2 of roadmap
2. Achieve 50%+ backend coverage
3. Achieve 40%+ frontend coverage
4. Set up CI/CD pipeline

### Long Term (Next Quarter)
1. Complete all 5 phases
2. Achieve 80%+ overall coverage
3. Implement automated regression testing
4. Add performance testing

---

**Last Updated:** 2025-11-10
**Status:** Testing infrastructure NOT implemented
**Priority:** CRITICAL - Must be addressed before major refactoring or new features
