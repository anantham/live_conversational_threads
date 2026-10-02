import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TooltipButton from "./TooltipButton";

/* Test intent: disabled help is keyboard-readable without activating; Escape
 * dismisses help; enabled buttons still act normally; unmount removes the hint. */
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("TooltipButton", () => {
  it("explains a disabled button on focus without activating it", () => {
    const activate = vi.fn();
    act(() => root.render(<TooltipButton disabled aria-label="Back" tooltip="No earlier exploration yet." onClick={activate}>←</TooltipButton>));
    const button = container.querySelector("button"), help = container.querySelector('[role="group"]');
    act(() => help.focus());
    expect(document.querySelector('[role="tooltip"]').textContent).toBe("No earlier exploration yet.");
    expect(help.getAttribute("aria-describedby")).toBe(document.querySelector('[role="tooltip"]').id);
    act(() => { help.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true})); button.click(); });
    expect(activate).not.toHaveBeenCalled(); expect(button.disabled).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(help);
  });

  it("keeps enabled activation and dismisses help on click or blur", () => {
    let count = 0;
    act(() => root.render(<TooltipButton aria-label="Next" tooltip="Next moment in this thread." onClick={() => {count++;}}>Next</TooltipButton>));
    const button = container.querySelector("button");
    act(() => button.focus()); expect(document.querySelector('[role="tooltip"]').textContent).toContain("this thread");
    act(() => button.click()); expect(count).toBe(1); expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {button.blur(); button.focus();}); expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => button.blur()); expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("removes visible help when its control leaves the view", () => {
    act(() => root.render(<TooltipButton aria-label="Forward" tooltip="Revisit later exploration.">→</TooltipButton>));
    act(() => container.querySelector("button").focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => root.render(null));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})));
    expect(container.textContent).toBe("");
  });

  it("dismisses hover help without consuming Escape from another focused control", () => {
    let cancelled = 0;
    act(() => root.render(<><TooltipButton aria-label="Back" tooltip="Exploration history.">←</TooltipButton><input aria-label="Unrelated input" /></>));
    const input = container.querySelector("input");
    input.addEventListener("keydown", event => { if (event.key === "Escape") cancelled++; });
    act(() => {
      input.focus();
      container.querySelector("span").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(escape));
    expect(cancelled).toBe(1);
    expect(escape.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(input);
  });
});
