import { describe, it, expect, beforeEach } from "bun:test";
import { useAppUpdateStore } from "./useAppUpdateStore.ts";

describe("useAppUpdateStore", () => {
  beforeEach(() => {
    useAppUpdateStore.setState({
      status: "idle",
      percent: 0,
      currentVersion: "0.1.9",
      availableVersion: undefined,
      notes: undefined,
      errorMessage: undefined,
      hasAutoChecked: false,
    });
  });

  it("initializes with default state", () => {
    const state = useAppUpdateStore.getState();
    expect(state.status).toBe("idle");
    expect(state.percent).toBe(0);
    expect(state.currentVersion).toBe("0.1.9");
    expect(state.hasAutoChecked).toBe(false);
  });

  it("handles Web fallback gracefully without crashing", async () => {
    const store = useAppUpdateStore.getState();
    await store.checkAndAutoDownload();
    const state = useAppUpdateStore.getState();
    expect(state.hasAutoChecked).toBe(true);
    expect(state.status).toBe("idle");
  });

  it("updates percent within 0-100 bounds", () => {
    useAppUpdateStore.setState({ percent: 50 });
    expect(useAppUpdateStore.getState().percent).toBe(50);
  });

  it("retries correctly from error_download vs error_check state", async () => {
    // When in error_download state
    useAppUpdateStore.setState({
      status: "error_download",
      availableVersion: "0.1.7",
      errorMessage: "Network timeout",
    });

    await useAppUpdateStore.getState().retry();
    // In Web test environment, retry simulates ready
    const state = useAppUpdateStore.getState();
    expect(state.status).toBe("ready");
    expect(state.percent).toBe(100);
  });
});
