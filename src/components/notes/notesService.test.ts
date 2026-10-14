import { describe, it, expect } from "bun:test";
import { notesService } from "./notesService";

describe("notesService Web Mock fallback tests", () => {
  it("ensureRoot should initialize default notebook", async () => {
    const root = await notesService.ensureRoot();
    expect(root.name).toBe("default");
    expect(root.relativePath).toBe("default");
  });

  it("listNotebooks should return notebooks list containing default", async () => {
    const list = await notesService.listNotebooks();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].name).toBe("default");
  });

  it("createNotebook should support subfolder in default notebook", async () => {
    const sub = await notesService.createNotebook("default", "work");
    expect(sub.name).toBe("work");
    expect(sub.relativePath).toBe("default/work");
  });

  it("createNote and readNote should work correctly", async () => {
    const created = await notesService.createNote("default", "MyNote");
    expect(created.title).toBe("MyNote");
    expect(created.fileName).toBe("MyNote.md");

    const content = await notesService.readNote("default", created.fileName);
    expect(content).toContain("# MyNote");

    await notesService.saveNote("default", created.fileName, "# MyNote\n\nUpdated Content");
    const updatedContent = await notesService.readNote("default", created.fileName);
    expect(updatedContent).toContain("Updated Content");
  });

  it("renameNote and deleteNote should update note list", async () => {
    const created = await notesService.createNote("default", "ToRename");
    const renamed = await notesService.renameNote("default", created.fileName, "RenamedTitle");
    expect(renamed.title).toBe("RenamedTitle");
    expect(renamed.fileName).toBe("RenamedTitle.md");

    await notesService.deleteNote("default", renamed.fileName);
    const list = await notesService.listNotes("default");
    expect(list.find((it) => it.fileName === renamed.fileName)).toBeUndefined();
  });

  it("renameNotebook and deleteNotebook should update folder list", async () => {
    const created = await notesService.createNotebook(null, "TestFolder");
    expect(created.name).toBe("TestFolder");

    await notesService.renameNotebook("TestFolder", "RenamedFolder");
    const listAfterRename = await notesService.listNotebooks();
    expect(listAfterRename.find((n) => n.name === "RenamedFolder")).toBeDefined();

    await notesService.deleteNotebook("TestFolder");
    const listAfterDelete = await notesService.listNotebooks();
    expect(listAfterDelete.find((n) => n.name === "RenamedFolder")).toBeUndefined();
  });
});

