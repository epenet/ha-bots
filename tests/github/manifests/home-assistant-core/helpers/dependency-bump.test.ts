import { describe, expect, it } from "vitest";
import type { ListPullRequestFiles } from "../../../../../src/github/engine/model/pull-request.js";
import { singleBump } from "../../../../../src/github/manifests/home-assistant-core/helpers/dependency-bump.js";

function bumpOf(...patches: string[]) {
  return singleBump(
    patches.map((patch) => ({ filename: "requirements_all.txt", patch })) as ListPullRequestFiles,
  );
}

describe("singleBump", () => {
  it("handles extras and name normalization across files", () => {
    expect(bumpOf("-Py_Foo[cli]==1.0\n+Py_Foo[cli]==1.1", "-py-foo==1.0\n+py-foo==1.1")).toEqual({
      name: "Py_Foo",
      version: "1.1",
    });
  });

  it("rejects newly added requirements", () => {
    expect(bumpOf("+newlib==1.0")).toBeUndefined();
  });

  it("rejects conflicting target versions", () => {
    expect(bumpOf("-foo==1\n+foo==2", "-foo==1\n+foo==3")).toBeUndefined();
  });

  it("only reads requirement files", () => {
    const files = [{ filename: "README.md", patch: "-foo==1\n+foo==2" }] as ListPullRequestFiles;
    expect(singleBump(files)).toBeUndefined();
  });
});
