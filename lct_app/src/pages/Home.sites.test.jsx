import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));
vi.mock("../components/ServiceStatus", () => ({ default: () => <span>Legacy service status</span> }));

import Home from "./Home";

describe("Home in Sites mode", () => {
  it("omits the private backend service status while retaining public browse", () => {
    vi.stubEnv("VITE_SITES_MODE", "true");
    try {
      const html = renderToStaticMarkup(<Home />);
      expect(html).toContain("Browse");
      expect(html).not.toContain("Legacy service status");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
