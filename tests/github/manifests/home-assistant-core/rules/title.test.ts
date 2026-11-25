import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "../../../../../src/github/engine/event.js";
import { resetIntegrationManifests } from "../../../../../src/github/helpers/integration-manifest.js";
import {
  tierOnlyChange,
  title as titleRule,
} from "../../../../../src/github/manifests/home-assistant-core/rules/title.js";
import { createMockContext, mockPRFiles, runRule } from "../../../helpers/mock-context.js";

const DEPENDENCY_BODY = "- [x] Dependency upgrade\n- [ ] New integration (thank you!)\n";
const OTHER_BODY = "- [ ] Dependency upgrade\n- [x] New integration (thank you!)\n";

const IOMETER_PATCH =
  "@@ -1,3 +1,3 @@\n # homeassistant.components.iometer\n-iometer==1.0.2\n+iometer==1.0.3\n";
const HASSFEST_LIST = "script/hassfest/quality_scale.py";

function makeFile(filename: string, patch = "", status = "modified") {
  return { filename, status, additions: 1, deletions: 1, changes: 2, patch };
}

function component(path: string, patch = "", status = "modified") {
  return makeFile(`homeassistant/components/iometer/${path}`, patch, status);
}

const BUMP_FILES = [component("manifest.json"), makeFile("requirements_all.txt", IOMETER_PATCH)];

async function run({
  eventType = EventType.PULL_REQUEST_OPENED,
  title,
  body = OTHER_BODY,
  author = "testuser",
  sender = author,
  base = "dev",
  files = [component("sensor.py")],
}: {
  eventType?: EventType;
  title: string;
  body?: string;
  author?: string;
  sender?: string;
  base?: string;
  files?: Record<string, unknown>[];
}) {
  const context = createMockContext({
    eventType,
    payload: {
      sender: { login: sender, type: sender.endsWith("[bot]") ? "Bot" : "User" },
      pull_request: { title, body, user: { login: author }, base: { ref: base } },
    },
  });
  mockPRFiles(context, files);
  const result = await runRule(titleRule, context);
  expect(result?.effects).toEqual([]);
  return result?.section;
}

describe("title", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetIntegrationManifests();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ domain: "iometer", name: "IOmeter (local)" }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  describe("dependency bump", () => {
    const bump = (title: string, extra: Record<string, unknown>[] = []) =>
      run({ title, body: DEPENDENCY_BODY, files: [...BUMP_FILES, ...extra] });

    it.each([
      "iometer dependency update to 1.0.3",
      "Update iometer to 1.0.3",
      "Bump iometer to fix stale sessions",
      "Bump iometer to 1.0.3 for IOmeter",
      "Bump iometer to 1.0.2",
    ])("fails %s", async (title) => {
      const section = await bump(title);
      expect(section?.status).toBe("fail");
      expect(section?.message).toContain("`Bump iometer to 1.0.3`");
      expect(section?.message).toContain("description");
    });

    it.each([
      "Bump iometer to 1.0.3",
      "Bump IOmeter to v1.0.3",
      "Downgrade iometer to 1.0.3",
      "Bump iometer from 1.0.2 to 1.0.3",
    ])("passes %s", async (title) => {
      expect(await bump(title)).toMatchObject({ status: "pass" });
    });

    it.each([
      ["home-assistant-frontend", "Update frontend to 2", "pass"],
      ["home-assistant-frontend", "Bump home-assistant-frontend to 2", "pass"],
      ["home-assistant-intents", "Bump intents to 2", "pass"],
      ["home-assistant-intents", "Update intents to 2", "fail"],
      ["py_foo.bar", "Bump py-foo-bar to 2", "pass"],
    ])("for %s, %s is a %s", async (name, title, status) => {
      const files = [makeFile("requirements_all.txt", `-${name}==1\n+${name}==2`)];
      expect(await run({ title, body: DEPENDENCY_BODY, files })).toMatchObject({ status });
    });

    it("fails a lowercase first letter", async () => {
      expect(await bump("bump iometer to 1.0.3")).toMatchObject({
        status: "fail",
        message: expect.stringContaining("capital"),
      });
    });

    it("fails with test changes too", async () => {
      const tests = [makeFile("tests/components/iometer/snapshots/test_sensor.ambr")];
      expect(await bump("Update iometer", tests)).toMatchObject({ status: "fail" });
    });

    it("only warns next to code", async () => {
      const section = await bump("Add a sensor to iometer", [component("sensor.py")]);
      expect(section?.status).toBe("warn");
      expect(section?.message).toContain("if the bump is its purpose");
    });

    it("needs the Dependency upgrade box", async () => {
      expect(await run({ title: "Fix reconnects in iometer", files: BUMP_FILES })).toMatchObject({
        status: "pass",
      });
    });

    it.each([
      ["several packages", `${IOMETER_PATCH}-foo==1\n+foo==2\n`],
      ["a package replacement", "-foo==1\n+foo-ng==2\n"],
      ["a constraint-only change", "-httplib2>=0.19.0\n+httplib2>=0.32.0\n"],
    ])("leaves %s alone", async (_name, patch) => {
      const files = [makeFile("requirements_all.txt", patch)];
      expect(await run({ title: "Update some pins", body: DEPENDENCY_BODY, files })).toMatchObject({
        status: "pass",
      });
    });
  });

  describe("new integration", () => {
    const manifest = JSON.stringify({ domain: "iometer", name: "IOmeter" }, null, 2)
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
    const files = [
      component("manifest.json", manifest, "added"),
      component("__init__.py", "", "added"),
      component("config_flow.py", "", "added"),
      component("quality_scale.yaml", "", "added"),
    ];

    it.each([
      "Add IOmeter integration",
      "Add IOmeter Energy integration",
      "Add IOmeter virtual integration",
    ])("passes %s", async (title) => {
      expect(await run({ title, files })).toMatchObject({ status: "pass" });
    });

    it.each([
      "Add iometer integration",
      "Add iOmeter energy integration",
      "Add IOmeter Integration",
      "Add iometer",
      "Add IOmeter (local) integration support",
      "Add new IOmeter integration",
      "Add a new integration",
      "Introduce the IOmeter integration",
      "Add IOmeter integration (config flow + sensor)",
    ])("fails %s", async (title) => {
      const section = await run({ title, files });
      expect(section?.status).toBe("fail");
      expect(section?.message).toContain("`Add IOmeter integration`");
    });

    it("suggests a title for a virtual integration", async () => {
      const virtual = `+${JSON.stringify({ domain: "aeg", name: "AEG", integration_type: "virtual" })}`;
      const section = await run({
        title: "Add aeg virtual integration supported by electrolux",
        files: [makeFile("homeassistant/components/aeg/manifest.json", virtual, "added")],
      });
      expect(section?.status).toBe("fail");
      expect(section?.message).toContain("`Add AEG virtual integration`");
    });

    it("checks only the style when several are added", async () => {
      const second = makeFile("homeassistant/components/other/manifest.json", manifest, "added");
      expect(await run({ title: "Add two things", files: [...files, second] })).toMatchObject({
        status: "pass",
      });
    });
  });

  describe("quality scale", () => {
    const tierPatch =
      '@@ -8,3 +8,4 @@\n-  "requirements": ["iometer==1"]\n+  "requirements": ["iometer==1"],\n+  "quality_scale": "bronze"\n';

    it.each([
      ["Update quality scale rules in", [component("quality_scale.yaml")]],
      [
        "Add quality scale file to",
        [component("quality_scale.yaml", "", "added"), makeFile(HASSFEST_LIST)],
      ],
      [
        "Set quality scale to bronze in",
        [component("manifest.json", tierPatch), makeFile(HASSFEST_LIST)],
      ],
      [
        "Set quality scale to bronze in",
        [component("manifest.json", tierPatch), component("quality_scale.yaml")],
      ],
    ])("wants %s <integration>", async (text, files) => {
      const expected = `${text} IOmeter (local)`;
      expect(await run({ title: expected, files })).toMatchObject({ status: "pass" });

      const section = await run({ title: "Mark things as done", files });
      expect(section?.status).toBe("fail");
      expect(section?.message).toContain(`\`${expected}\``);
    });

    it("accepts any name when the manifest can't be read", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 });
      const files = [component("quality_scale.yaml")];
      expect(await run({ title: "Update quality scale rules in Foo", files })).toMatchObject({
        status: "pass",
      });
    });

    it.each([
      ["code", [component("quality_scale.yaml"), component("sensor.py")]],
      [
        "the manifest",
        [component("quality_scale.yaml"), component("manifest.json", '+  "name": "B"')],
      ],
      [
        "another integration",
        [
          component("quality_scale.yaml"),
          makeFile("homeassistant/components/other/quality_scale.yaml"),
        ],
      ],
      ["tests", [component("quality_scale.yaml"), makeFile("tests/components/iometer/a.py")]],
    ])("ignores rules changed with %s", async (_name, files) => {
      expect(await run({ title: "Add diagnostics", files })).toMatchObject({ status: "pass" });
    });
  });

  it("wants config flows titled after the integration", async () => {
    const files = [component("config_flow.py", "", "added"), component("manifest.json")];
    expect(await run({ title: "Add config flow to IOmeter (local)", files })).toMatchObject({
      status: "pass",
    });
    const section = await run({ title: "Migrate to config entries", files });
    expect(section?.status).toBe("fail");
    expect(section?.message).toContain("`Add config flow to IOmeter (local)`");
  });

  it("fails style problems in other PRs", async () => {
    const section = await run({ title: "iometer: add a sensor" });
    expect(section?.status).toBe("fail");
    expect(section?.message).toContain("prefix");
  });

  it.each([
    EventType.PULL_REQUEST_REOPENED,
    EventType.PULL_REQUEST_EDITED,
    EventType.PULL_REQUEST_SYNCHRONIZE,
    EventType.ON_DEMAND,
  ])("re-evaluates on %s", async (eventType) => {
    expect(await run({ eventType, title: "add a sensor" })).toMatchObject({ status: "fail" });
    expect(await run({ eventType, title: "Add a sensor" })).toMatchObject({ status: "pass" });
  });

  it("skips bot authors, whoever sends the event", async () => {
    const pr = { title: "chore: update", author: "renovate[bot]" };
    expect(await run(pr)).toMatchObject({ status: "skip" });
    expect(
      await run({ ...pr, sender: "maintainer", eventType: EventType.PULL_REQUEST_SYNCHRONIZE }),
    ).toMatchObject({ status: "skip" });
  });

  it("is strict about the case of the tier", async () => {
    const files = [component("manifest.json", '+  "quality_scale": "gold"')];
    const title = "Set quality scale to Gold in IOmeter (local)";
    expect(await run({ title, files })).toMatchObject({ status: "fail" });
  });

  it("skips reverts", async () => {
    expect(await run({ title: 'Revert "Add flow visibility (#187515)"' })).toMatchObject({
      status: "skip",
    });
    expect(
      await run({ title: "Revert iometer to 1.0.2", body: DEPENDENCY_BODY, files: BUMP_FILES }),
    ).toMatchObject({ status: "skip" });
  });

  it("skips release PRs", async () => {
    expect(await run({ title: "2026.11.3", base: "master" })).toMatchObject({ status: "skip" });
  });
});

describe("tierOnlyChange", () => {
  it("reads a changed tier", () => {
    expect(tierOnlyChange('-  "quality_scale": "silver",\n+  "quality_scale": "gold",')).toBe(
      "gold",
    );
  });

  it("rejects other manifest changes and a removed tier", () => {
    expect(
      tierOnlyChange('+  "quality_scale": "gold",\n-  "name": "A"\n+  "name": "B"'),
    ).toBeUndefined();
    expect(tierOnlyChange('-  "quality_scale": "gold"')).toBeUndefined();
  });
});
