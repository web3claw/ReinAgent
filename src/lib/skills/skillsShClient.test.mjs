import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillsFromHtml } from "./skillsShClient.ts";

test("parseSkillsFromHtml：解析 Next.js 流式嵌入的技能 JSON", () => {
  const fakeHtml = `
    <html>
      <body>
        <script>
          self.__next_f.push([1, "some text {\\"source\\":\\"vercel-labs/skills\\",\\"skillId\\":\\"find-skills\\",\\"name\\":\\"find-skills\\",\\"installs\\":4100000} and {\\"source\\":\\"mattpocock/skills\\",\\"skillId\\":\\"grill-me\\",\\"name\\":\\"grill-me\\",\\"installs\\":1500000}"]);
        </script>
      </body>
    </html>
  `;

  const skills = parseSkillsFromHtml(fakeHtml);
  assert.equal(skills.length, 2);
  assert.equal(skills[0].id, "vercel-labs/skills/find-skills");
  assert.equal(skills[0].skill_id, "find-skills");
  assert.equal(skills[0].name, "find-skills");
  assert.equal(skills[0].installs, 4100000);

  assert.equal(skills[1].id, "mattpocock/skills/grill-me");
  assert.equal(skills[1].skill_id, "grill-me");
  assert.equal(skills[1].installs, 1500000);
});

test("parseSkillsFromHtml：去重与缺失处理", () => {
  const fakeHtml = `
    {"source":"a/b","skillId":"s1","name":"s1","installs":10}
    {"source":"a/b","skillId":"s1","name":"s1","installs":10}
  `;
  const skills = parseSkillsFromHtml(fakeHtml);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "a/b/s1");
});

test("parseSkillsFromHtml：解析真实 skills.sh 真实响应样本", async () => {
  const fs = await import("node:fs/promises");
  try {
    const realHtml = await fs.readFile(
      "/home/web3claw/.gemini/antigravity/brain/43af37ff-29a3-48ce-bb34-2fc04af65daf/.system_generated/tasks/task-1155.log",
      "utf8",
    );
    const skills = parseSkillsFromHtml(realHtml);
    assert.ok(skills.length > 5, `Expected > 5 skills, got ${skills.length}`);
    const findSkills = skills.find((s) => s.skill_id === "find-skills");
    assert.ok(findSkills, "Expected to find find-skills");
    assert.equal(findSkills.source, "vercel-labs/skills");
    assert.ok(findSkills.installs > 1000000);
  } catch (err) {
    if (String(err).includes("ENOENT")) {
      // 临时日志可能被清理，跳过
      return;
    }
    throw err;
  }
});

