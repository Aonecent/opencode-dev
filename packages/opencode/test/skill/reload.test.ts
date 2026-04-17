import { afterEach, test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

afterEach(async () => {
  await Instance.disposeAll()
})

async function write(dir: string, name: string, desc: string, body = "") {
  const root = path.join(dir, ".opencode", "skill", name)
  await fs.mkdir(root, { recursive: true })
  await Bun.write(
    path.join(root, "SKILL.md"),
    `---
name: ${name}
description: ${desc}
---

# ${name}
${body}
`,
  )
}

test("reload picks up newly added skills", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Skill.all()).length).toBe(0)

      await write(tmp.path, "fresh-skill", "A brand new skill.")
      const result = await Skill.reload()
      expect(result.added).toEqual(["fresh-skill"])
      expect(result.removed).toEqual([])
      expect(result.changed).toEqual([])
      expect(result.total).toBe(1)

      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("fresh-skill")
    },
  })
})

test("reload detects removed and changed skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await write(dir, "keeper", "Stays around.")
      await write(dir, "goner", "Will be deleted.")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Skill.all()).length).toBe(2)

      await fs.rm(path.join(tmp.path, ".opencode", "skill", "goner"), { recursive: true, force: true })
      await write(tmp.path, "keeper", "Stays around.", "updated body")

      const result = await Skill.reload()
      expect(result.removed).toEqual(["goner"])
      expect(result.changed).toEqual(["keeper"])
      expect(result.added).toEqual([])
      expect(result.total).toBe(1)

      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("keeper")
    },
  })
})
