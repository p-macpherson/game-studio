import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

const DIFF = `diff --git a/docs/a b.md b/docs/a b.md
index 1111111..2222222 100644
--- a/docs/a b.md
+++ b/docs/a b.md
@@ -3,4 +3,5 @@ # Heading
 same
-old line
+new line
+another
 tail
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
\\ No newline at end of file
diff --git a/art/old.png b/art/new.png
similarity index 100%
rename from art/old.png
rename to art/new.png
diff --git a/tex.png b/tex.png
index 5555555..6666666 100644
Binary files a/tex.png and b/tex.png differ
diff --git a/big.glb b/big.glb
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/big.glb
@@ -0,0 +1,3 @@
+version https://git-lfs.github.com/spec/v1
+oid sha256:abc
+size 785
`;

describe("parseDiff", () => {
	const files = parseDiff(DIFF);
	it("splits a diff into files with their kind of change and line counts", () => {
		expect(files.map((f) => [f.path, f.change, f.added, f.removed, f.binary])).toEqual([
			["docs/a b.md", "modified", 2, 1, false],
			["new.txt", "added", 2, 0, false],
			["gone.txt", "deleted", 0, 1, false],
			["art/new.png", "renamed", 0, 0, false],
			["tex.png", "modified", 0, 0, true],
			["big.glb", "added", 0, 0, true],
		]);
		expect(files[5].size).toBe(785);
		expect(files[3].from).toBe("art/old.png");
	});
	it("numbers each line on the side it is in", () => {
		const h = files[0].hunks[0];
		expect(h.context).toBe("# Heading");
		expect(h.lines).toEqual([
			{ kind: "context", old: 3, new: 3, text: "same" },
			{ kind: "del", old: 4, text: "old line" },
			{ kind: "add", new: 4, text: "new line" },
			{ kind: "add", new: 5, text: "another" },
			{ kind: "context", old: 5, new: 6, text: "tail" },
		]);
	});
});
