import { describe, it, expect } from "bun:test";
import { translations } from "../../i18n/index.ts";

describe("SidebarVersionUpdater translations and keys", () => {
  it("provides updaterCheckAndDownload in both zh-CN and en-US", () => {
    expect(translations["zh-CN"].updaterCheckAndDownload).toBe("检查和下载更新");
    expect(translations["en-US"].updaterCheckAndDownload).toBe("Check and download updates");
  });
});
