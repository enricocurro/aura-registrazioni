/**
 * Archivio su file: una cartella, nessun database.
 *
 *   data/recordings/<id>.json           scheda della registrazione (battute, valutazioni, note)
 *   data/recordings/<id>.pcm            campioni in arrivo, mentre si registra
 *   data/recordings/<id>.wav            audio completo, a registrazione chiusa
 *   data/recordings/<id>.analysis.json  volume e intonazione ogni 20 ms
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID_PATTERN = /^[a-z0-9]{16}$/;

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function createStore(dataDir) {
  const dir = join(dataDir, "recordings");
  /** Una coda per registrazione: le scritture sulla stessa scheda non si accavallano. */
  const queues = new Map();

  const file = (id, ext) => {
    if (!isValidId(id)) throw new Error("id non valido");
    return join(dir, `${id}.${ext}`);
  };

  function enqueue(id, task) {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  async function writeJson(path, value) {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 1));
    await rename(tmp, path);
  }

  async function read(id) {
    try {
      return JSON.parse(await readFile(file(id, "json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async init() {
      await mkdir(dir, { recursive: true });
      // Difesa in più se per errore la cartella dei dati finisse sotto la radice web di Apache.
      // Non sostituisce la regola: i dati devono stare FUORI dalla cartella pubblicata.
      await writeFile(join(dataDir, ".htaccess"), "Require all denied\n").catch(() => {});
    },

    newId() {
      return randomBytes(8).toString("hex");
    },

    path: file,
    read,

    async create(record) {
      await writeJson(file(record.id, "json"), record);
      await writeFile(file(record.id, "pcm"), Buffer.alloc(0));
      return record;
    },

    /** Legge, modifica e riscrive la scheda; `change` può restituire `false` per non salvare. */
    update(id, change) {
      return enqueue(id, async () => {
        const record = await read(id);
        if (!record) return null;
        const result = await change(record);
        if (result === false) return record;
        record.updatedAt = new Date().toISOString();
        await writeJson(file(id, "json"), record);
        return record;
      });
    },

    appendPcm(id, buffer) {
      return enqueue(id, () => appendFile(file(id, "pcm"), buffer));
    },

    async pcmSize(id) {
      try {
        return (await stat(file(id, "pcm"))).size;
      } catch {
        return 0;
      }
    },

    async list() {
      const names = (await readdir(dir)).filter((name) => /^[a-z0-9]{16}\.json$/.test(name));
      const records = await Promise.all(names.map((name) => read(name.slice(0, 16))));
      return records.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async remove(id) {
      await enqueue(id, async () => {
        await Promise.all(
          ["json", "pcm", "wav", "analysis.json"].map((ext) => rm(file(id, ext), { force: true })),
        );
      });
      queues.delete(id);
    },

    writeJson,
  };
}
