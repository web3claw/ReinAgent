import test from "node:test";
import assert from "node:assert/strict";
import {
  getDefaultWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveWorkspacePath,
  isAbsolutePath,
  normalizePath,
} from "./workspace.ts";

test("1 · normalizePath 正确规范化正反斜杠与冗余分段", () => {
  assert.equal(normalizePath("/foo/bar/../baz"), "/foo/baz");
  assert.equal(normalizePath("/foo/./bar//baz/"), "/foo/bar/baz");
  assert.equal(normalizePath("foo/bar"), "foo/bar");
});

test("2 · isAbsolutePath 正确判断绝对路径", () => {
  assert.ok(isAbsolutePath("/home/user/project"));
  assert.ok(isAbsolutePath("C:\\Users\\project"));
  assert.ok(isAbsolutePath("D:/project"));
  assert.ok(!isAbsolutePath("relative/path"));
  assert.ok(!isAbsolutePath("./relative/path"));
  assert.ok(!isAbsolutePath("../parent"));
});

test("3 · getDefaultWorkspaceRoot 默认指向 ~/.ReinAgent/DefaultProject", () => {
  const root = getDefaultWorkspaceRoot();
  assert.ok(root.endsWith("/.ReinAgent/DefaultProject"), `应以 /.ReinAgent/DefaultProject 结尾，实际为: ${root}`);
});

test("4 · resolveWorkspaceRoot: 指定项目优先，未指定项目兜底 DefaultProject", () => {
  // 指定了项目路径
  const customProject = "/home/web3claw/DevCode/MyApp";
  assert.equal(resolveWorkspaceRoot(customProject), customProject);

  // 未指定项目（null 或 undefined 或空串）
  const fallback = getDefaultWorkspaceRoot();
  assert.equal(resolveWorkspaceRoot(null), fallback);
  assert.equal(resolveWorkspaceRoot(undefined), fallback);
  assert.equal(resolveWorkspaceRoot(""), fallback);
  assert.equal(resolveWorkspaceRoot("   "), fallback);

  // 波浪号 ~ 简写支持
  const tildePath = "~/Workspace/Demo";
  const resolvedTilde = resolveWorkspaceRoot(tildePath);
  assert.ok(!resolvedTilde.startsWith("~"), "波浪号应被解析");
  assert.ok(resolvedTilde.endsWith("/Workspace/Demo"));
});

test("5 · resolveWorkspacePath 对齐 ZCode：相对路径自动基于工作区解析，绝对路径保持不变", () => {
  const workspaceRoot = "/home/web3claw/MyProject";

  // 1. 相对路径（如单文件名）-> 自动拼接到工作区下
  assert.equal(
    resolveWorkspacePath("multiplication_table.py", workspaceRoot),
    "/home/web3claw/MyProject/multiplication_table.py",
  );

  // 2. 相对路径（如子目录）-> 自动拼接
  assert.equal(
    resolveWorkspacePath("src/components/Button.tsx", workspaceRoot),
    "/home/web3claw/MyProject/src/components/Button.tsx",
  );

  // 3. 相对路径（带 ./）
  assert.equal(
    resolveWorkspacePath("./scripts/build.sh", workspaceRoot),
    "/home/web3claw/MyProject/scripts/build.sh",
  );

  // 4. 绝对路径 -> 保持原绝对路径
  assert.equal(
    resolveWorkspacePath("/tmp/other/file.txt", workspaceRoot),
    "/tmp/other/file.txt",
  );

  // 5. 空路径 -> 返回工作区根目录
  assert.equal(resolveWorkspacePath("", workspaceRoot), workspaceRoot);
  assert.equal(resolveWorkspacePath("   ", workspaceRoot), workspaceRoot);
});
