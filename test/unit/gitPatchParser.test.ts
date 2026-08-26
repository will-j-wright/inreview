import { describe, expect, it } from "vitest";

import {
  commentableNewSideRanges,
  decodeTextForDisplay,
  GitPatchParseError,
  parseGitPatch,
} from "../../src/diff";

describe("Git patch parsing", () => {
  it("parses additions, quoted UTF-8 paths, empty files, and no-newline markers", () => {
    const patch = [
      'diff --git "a/caf\\303\\251 file.txt" "b/caf\\303\\251 file.txt"',
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      '+++ "b/caf\\303\\251 file.txt"',
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");

    const files = parseGitPatch(patch);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      status: "added",
      originalPath: null,
      currentPath: "café file.txt",
      addedLines: 1,
      deletedLines: 0,
    });
    expect(files[0]?.hunks[0]?.lines[0]).toMatchObject({
      kind: "addition",
      content: "hello",
      oldLine: null,
      newLine: 1,
      noNewlineAtEnd: true,
    });
    expect(files[1]).toMatchObject({
      status: "added",
      currentPath: "empty.txt",
      hunks: [],
      addedLines: 0,
    });
  });

  it("parses unquoted spaces and assigns exact old and new hunk ranges", () => {
    const [file] = parseGitPatch(
      [
        "diff --git a/path with spaces.txt b/path with spaces.txt",
        "index 1111111..2222222 100644",
        "--- a/path with spaces.txt",
        "+++ b/path with spaces.txt",
        "@@ -2,3 +2,4 @@ heading",
        " context",
        "-old",
        "+new",
        "+extra",
        " tail",
        "",
      ].join("\n"),
    );

    expect(file).toMatchObject({
      status: "modified",
      originalPath: "path with spaces.txt",
      currentPath: "path with spaces.txt",
      addedLines: 2,
      deletedLines: 1,
    });

    expect(file?.hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 4,
    });
    expect(file?.hunks[0]?.lines.map(({ kind, oldLine, newLine }) => ({
      kind,
      oldLine,
      newLine,
    }))).toEqual([
      { kind: "context", oldLine: 2, newLine: 2 },
      { kind: "deletion", oldLine: 3, newLine: null },
      { kind: "addition", oldLine: null, newLine: 3 },
      { kind: "addition", oldLine: null, newLine: 4 },
      { kind: "context", oldLine: 4, newLine: 5 },
    ]);
  });

  it("parses a literal quote in a quoted path", () => {
    const [file] = parseGitPatch(
      [
        'diff --git "a/a \\"quote\\".txt" "b/a \\"quote\\".txt"',
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n"),
    );

    expect(file).toMatchObject({
      originalPath: 'a "quote".txt',
      currentPath: 'a "quote".txt',
      status: "modified",
    });
  });

  it.each([
    [
      "deleted",
      [
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
      ],
      { status: "deleted", originalPath: "gone.txt", currentPath: null },
    ],
    [
      "renamed",
      [
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 100%",
        "rename from old name.txt",
        "rename to new name.txt",
      ],
      {
        status: "renamed",
        originalPath: "old name.txt",
        currentPath: "new name.txt",
      },
    ],
    [
      "copied",
      [
        "diff --git a/source.txt b/copy.txt",
        "similarity index 100%",
        "copy from source.txt",
        "copy to copy.txt",
      ],
      {
        status: "copied",
        originalPath: "source.txt",
        currentPath: "copy.txt",
      },
    ],
    [
      "mode-only",
      [
        "diff --git a/script.sh b/script.sh",
        "old mode 100644",
        "new mode 100755",
      ],
      {
        status: "modified",
        originalPath: "script.sh",
        currentPath: "script.sh",
        oldMode: "100644",
        newMode: "100755",
      },
    ],
  ])("parses a %s file", (_name, lines, expected) => {
    const [file] = parseGitPatch(`${lines.join("\n")}\n`);
    expect(file).toMatchObject(expected);
  });

  it("parses binary markers and symbolic-link target patches", () => {
    const files = parseGitPatch(
      [
        "diff --git a/data.bin b/data.bin",
        "index 1111111..2222222 100644",
        "Binary files a/data.bin and b/data.bin differ",
        "diff --git a/link b/link",
        "new file mode 120000",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1 @@",
        "+target/file",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );

    expect(files[0]).toMatchObject({ binary: true, hunks: [] });
    expect(files[1]).toMatchObject({
      status: "added",
      oldMode: null,
      newMode: "120000",
      addedLines: 1,
    });

  });

  it("accepts a Git binary payload without interpreting it as text", () => {
    const [file] = parseGitPatch(
      [
        "diff --git a/data.bin b/data.bin",
        "index 1111111..2222222 100644",
        "GIT binary patch",
        "literal 3",
        "KcmZQzWC8#H2LJ>B",
        "",
      ].join("\n"),
    );

    expect(file).toMatchObject({ binary: true, hunks: [] });
  });

  it("preserves invalid UTF-8 patch bytes and decodes CP1252 for display", () => {
    const prefix = Buffer.from(
      [
        "diff --git a/cafe.txt b/cafe.txt",
        "index 1111111..2222222 100644",
        "--- a/cafe.txt",
        "+++ b/cafe.txt",
        "@@ -1 +1 @@",
        "-plain",
        "+caf",
      ].join("\n"),
      "ascii",
    );
    const patch = Buffer.concat([prefix, Buffer.from([0xe9, 0x0a])]);

    const [file] = parseGitPatch(patch);

    expect(file?.hunks[0]?.lines[1]?.content).toBe("café");
    expect(file?.raw).toEqual(patch);
    expect(file?.raw.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it("degrades ambiguous metadata-only paths unless exact metadata resolves them", () => {
    const patch = Buffer.from(
      [
        "diff --git a/old b/one b/new b/two",
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n"),
    );

    const [ambiguous] = parseGitPatch(patch);
    expect(ambiguous).toMatchObject({
      pathResolution: "ambiguous",
      originalPath: null,
      currentPath: null,
      hunks: [],
    });

    const [resolved] = parseGitPatch(patch, [
      {
        status: "modified",
        originalPath: "old",
        currentPath: "one b/new b/two",
      },
    ]);
    expect(resolved).toMatchObject({
      pathResolution: "exact",
      originalPath: "old",
      currentPath: "one b/new b/two",
    });
  });

  it("computes only new-side context and addition ranges", () => {
    const [file] = parseGitPatch(
      [
        "diff --git a/file.txt b/file.txt",
        "index 1111111..2222222 100644",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -10,4 +10,4 @@",
        " first",
        "-removed",
        "+added",
        " third",
        " fourth",
        "@@ -30 +30 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );

    expect(commentableNewSideRanges(file?.hunks ?? [])).toEqual([
      { start: 10, end: 13 },
      { start: 30, end: 30 },
    ]);
    expect(
      file?.hunks.flatMap(({ lines }) =>
        lines.filter(({ kind }) => kind === "deletion").map(({ newLine }) => newLine),
      ),
    ).toEqual([null, null]);
  });

  it.each([
    [
      "truncated hunk",
      [
        "diff --git a/a.txt b/a.txt",
        "index 1..2 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        "-one",
        "+two",
      ].join("\n"),
    ],
    [
      "one-sided rename",
      [
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
      ].join("\n"),
    ],
    [
      "unsafe quoted path",
      [
        'diff --git "a/\\377.txt" "b/\\377.txt"',
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
    ],
    [
      "unknown header",
      ["diff --git a/a.txt b/a.txt", "totally unknown"].join("\n"),
    ],
    ["truncated file", "diff --git a/a.txt b/a.txt"],
  ])("rejects a malformed %s patch", (_name, patch) => {
    expect(() => parseGitPatch(patch)).toThrow(GitPatchParseError);
  });

  it("decodes safe text conservatively", () => {
    expect(decodeTextForDisplay(Buffer.from("hello π", "utf8"))).toBe("hello π");
    expect(decodeTextForDisplay(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(
      "café",
    );
    expect(() => decodeTextForDisplay(Buffer.from([0]))).toThrow(
      "contains NUL bytes",
    );
  });
});
